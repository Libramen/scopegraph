/**
 * `scopegraph orders` against a tiny local express stub implementing the
 * admin API shape (docs/payments.md § Approving from the terminal): bearer
 * ADMIN_TOKEN, `{orders: […]}` / `{order}`, `{error, message}` on failures.
 * Exercises parsing, output, error paths.
 */
import type { Server } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Order } from '../payments/types.js';
import { runOrders } from './orders.js';

const TOKEN = 'test-admin-token-0123456789abcdef';
const ENV = { ADMIN_TOKEN: TOKEN };

const requests: Array<{ method: string; path: string; body: unknown; token: string | undefined }> = [];

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_testaaaaaaaaaaaaaaaaaaaa',
    quoteId: 'qt_test0000000000000000000a',
    offering: 'surf-lesson',
    request: { answers: { participants: 2 }, selections: { rentals: ['softboard'] }, date: '2027-01-09' },
    quote: {
      currency: 'USD',
      lines: [
        {
          id: 'surf-lesson.base',
          label: 'Surf lesson',
          kind: 'base',
          amountCents: 20000,
          quantity: 2,
          unitAmountCents: 10000,
          taxable: true,
          source: { offering: 'surf-lesson' },
        },
        {
          id: 'surf-lesson.rentals.softboard.price',
          label: 'Softboard hire',
          kind: 'addon',
          amountCents: 3000,
          taxable: true,
          source: { offering: 'surf-lesson', option: 'softboard' },
        },
      ],
      subtotalCents: 23000,
      taxCents: 2300,
      totalCents: 25300,
    },
    confirmation: 'owner_approves',
    door: 'ucp',
    checkoutId: 'chk_test00000000000000000a',
    buyer: { name: 'Kai Anderson', email: 'kai@example.com' },
    createdAt: '2026-11-20T10:00:00.000Z',
    approvalDeadline: '2026-11-21T10:00:00.000Z',
    stripe: { paymentIntentId: 'pi_test_1' },
    status: 'awaiting_approval',
    pendingHooks: [],
    version: 3,
    ...overrides,
  };
}

const awaitingOrder = makeOrder();
const paidOrder = makeOrder({
  id: 'ord_testaaaaaaaaaaaaaaaaaaab',
  door: 'link',
  status: 'paid',
  confirmation: 'instant',
  checkoutId: undefined,
  buyer: undefined,
  approvalDeadline: undefined,
  stripe: { checkoutSessionId: 'cs_test_1' },
  lastOperation: { op: 'capture', result: 'succeeded', at: '2026-11-20T11:00:00.000Z' },
  version: 7,
});
// Fresh hold, no deadline yet: the stub's approve answers `capturing` (Stripe
// was ambiguous; the reconciler settles it) — used by the settling-note test.
const captureInFlight = makeOrder({
  id: 'ord_testaaaaaaaaaaaaaaaaaaac',
  approvalDeadline: undefined,
});
// Buyer-controlled text carrying terminal escapes (clear line, cursor up,
// OSC 52 clipboard write, OSC 8 hyperlink, C1 CSI): human output must escape them.
const ESC = '\u001b';
const hostileOrder = makeOrder({
  id: 'ord_testaaaaaaaaaaaaaaaaaaad',
  status: 'rejected',
  statusReason: `nope\u009b31m`,
  buyer: { name: `Ann${ESC}[2K${ESC}[1A${ESC}]52;c;eA==\u0007`, email: `a@example.com${ESC}]8;;https://evil.example\u0007` },
  request: { answers: { [`note${ESC}[2J`]: `hi${ESC}[1A` }, selections: {} },
});
const orders = [awaitingOrder, paidOrder, captureInFlight, hostileOrder];

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // tsconfig targets ES2022 (no Promise.withResolvers): executor form it is.
  const requireToken = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    requests.push({ method: req.method, path: req.originalUrl, body: req.body, token: header });
    if (header !== `Bearer ${TOKEN}`) {
      res.status(401).json({ error: 'unauthorized', message: 'missing or invalid admin token' });
      return;
    }
    next();
  };
  // A proxy-style redirect to another path: following it would replay the token.
  app.get('/hop/admin/orders', (_req, res) => res.redirect(302, '/stolen'));
  app.get('/stolen', requireToken, (_req, res) => res.json({ orders: [] }));
  app.get('/admin/orders', requireToken, (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json({ orders: status === undefined ? orders : orders.filter((order) => order.status === status) });
  });
  app.get('/admin/orders/:id', requireToken, (req, res) => {
    const order = orders.find((candidate) => candidate.id === req.params.id);
    if (order === undefined) {
      res.status(404).json({ error: 'order_not_found', message: `no order ${req.params.id}` });
      return;
    }
    res.json({ order });
  });
  app.post('/admin/orders/:id/approve', requireToken, (req, res) => {
    const order = orders.find((candidate) => candidate.id === req.params.id);
    if (order === undefined) {
      res.status(404).json({ error: 'order_not_found', message: `no order ${req.params.id}` });
      return;
    }
    // Approve with no deadline recorded yet → capture in flight (ambiguous
    // gateway): 200 with a non-terminal status; the reconciler finishes it.
    if (order.status === 'awaiting_approval' && order.approvalDeadline === undefined) {
      res.json({ order: { ...order, status: 'capturing', version: order.version + 1 } });
      return;
    }
    // Past-deadline approve: 200 with the order voided to expired, never captured.
    if (order.status === 'awaiting_approval') {
      res.json({
        order: { ...order, status: 'expired', statusReason: 'approval window elapsed', version: order.version + 1 },
      });
      return;
    }
    res.json({ order: { ...order, status: 'paid', version: order.version + 1 } });
  });
  app.post('/admin/orders/:id/reject', requireToken, (req, res) => {
    const order = orders.find((candidate) => candidate.id === req.params.id);
    if (order === undefined) {
      res.status(404).json({ error: 'order_not_found', message: `no order ${req.params.id}` });
      return;
    }
    if (order.status !== 'awaiting_approval') {
      res.status(409).json({ error: 'invalid_state', message: `order is ${order.status}` });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    res.json({
      order: {
        ...order,
        status: 'rejected',
        voidOutcome: 'rejected',
        statusReason: reason,
        version: order.version + 1,
      },
    });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

function capture(): { stdout: () => string; stderr: () => string } {
  const chunks = { out: '', err: '' };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.out += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.err += String(chunk);
    return true;
  });
  return {
    stdout: () => {
      out.mockRestore();
      return chunks.out;
    },
    stderr: () => {
      err.mockRestore();
      return chunks.err;
    },
  };
}

describe('runOrders', () => {
  it('lists orders as an aligned table with a hint to approve', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: baseUrl }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(stdout).toContain('ID');
    expect(stdout).toContain('ord_testaaaaaaaaaaaaaaaaaaaa');
    expect(stdout).toContain('awaiting_approval');
    expect(stdout).toContain('ucp');
    expect(stdout).toContain('$253.00');
    expect(stdout).toContain('kai@example.com');
    expect(stdout).toMatch(/awaiting your approval — approve with: npm run sg -- orders approve ord_/);
  });

  it('forwards --status as a query parameter and narrows the table', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: baseUrl, status: 'paid' }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(requests.at(-1)?.path).toBe('/admin/orders?status=paid');
    expect(stdout).toContain('ord_testaaaaaaaaaaaaaaaaaaab');
    expect(stdout).not.toContain('ord_testaaaaaaaaaaaaaaaaaaaa');
  });

  it('prints an empty-list notice for a status with no orders', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: baseUrl, status: 'refunded' }, ENV);
    expect(code).toBe(0);
    expect(streams.stdout()).toBe('No orders with status refunded.\n');
  });

  it('prints the server body verbatim with --json', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: baseUrl, json: true }, ENV);
    expect(code).toBe(0);
    expect(JSON.parse(streams.stdout())).toEqual({ orders });
  });

  it('shows one order with buyer, request and quote lines', async () => {
    const streams = capture();
    const code = await runOrders(['show', awaitingOrder.id], { url: baseUrl }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(stdout).toContain(`order ${awaitingOrder.id}`);
    expect(stdout).toContain('YOU must approve or reject this order');
    expect(stdout).toContain('Kai Anderson <kai@example.com>');
    expect(stdout).toContain('participants=2');
    expect(stdout).toContain('rentals=[softboard]');
    expect(stdout).toContain('date=2027-01-09');
    expect(stdout).toContain('Softboard hire');
    expect(stdout).toContain('Total');
  });

  it('shows a bare --json order', async () => {
    const streams = capture();
    const code = await runOrders(['show', awaitingOrder.id], { url: baseUrl, json: true }, ENV);
    expect(code).toBe(0);
    expect(JSON.parse(streams.stdout())).toEqual({ order: awaitingOrder });
  });

  it('approve prints the resulting status without assuming paid (past deadline → expired)', async () => {
    const streams = capture();
    const code = await runOrders(['approve', awaitingOrder.id], { url: baseUrl }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: `/admin/orders/${awaitingOrder.id}/approve` });
    expect(stdout).toContain('expired');
    expect(stdout).toContain('reason: approval window elapsed');
    expect(stdout).not.toContain('paid');
  });

  it('reject sends the reason and prints the resulting order', async () => {
    const streams = capture();
    const code = await runOrders(['reject', awaitingOrder.id], { url: baseUrl, reason: 'no boards left' }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ reason: 'no boards left' });
    expect(stdout).toContain('rejected');
    expect(stdout).toContain('reason: no boards left');
  });

  it('notes when an approve result is still settling (capture in flight)', async () => {
    const streams = capture();
    const code = await runOrders(['approve', captureInFlight.id], { url: baseUrl }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(stdout).toContain('capturing');
    expect(stdout).toContain('still settling');
    expect(stdout).toContain(`npm run sg -- orders show ${captureInFlight.id}`);
  });

  it('terminal results do not carry the settling note', async () => {
    const streams = capture();
    const code = await runOrders(['approve', paidOrder.id], { url: baseUrl }, ENV);
    const stdout = streams.stdout();
    expect(code).toBe(0);
    expect(stdout).toContain('paid');
    expect(stdout).not.toContain('still settling');
  });

  it('rejects on state conflict with the server message', async () => {
    const streams = capture();
    const code = await runOrders(['reject', paidOrder.id], { url: baseUrl }, ENV);
    expect(code).toBe(1);
    expect(streams.stderr()).toContain('order is paid (invalid_state)');
  });

  it('unauthorized prints an ADMIN_TOKEN hint', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: baseUrl }, { ADMIN_TOKEN: 'wrong-token' });
    expect(code).toBe(1);
    expect(streams.stderr()).toContain('check ADMIN_TOKEN');
  });

  it('missing ADMIN_TOKEN fails before any request', async () => {
    const before = requests.length;
    const streams = capture();
    const code = await runOrders(['list'], { url: baseUrl }, {});
    expect(code).toBe(1);
    expect(streams.stderr()).toContain('ADMIN_TOKEN is not set');
    expect(requests.length).toBe(before);
  });

  it('an unreachable server exits 1 with a pointer to deploy docs', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: 'http://127.0.0.1:1' }, ENV);
    expect(code).toBe(1);
    expect(streams.stderr()).toContain('cannot reach the server');
  });

  it('usage errors: no subcommand, unknown subcommand, missing id, bad status', async () => {
    const none = capture();
    expect(await runOrders([], { url: baseUrl }, ENV)).toBe(2);
    expect(none.stderr()).toContain('needs a subcommand');

    const unknown = capture();
    expect(await runOrders(['delete'], { url: baseUrl }, ENV)).toBe(2);
    expect(unknown.stderr()).toContain("unknown orders subcommand 'delete'");

    const missingId = capture();
    expect(await runOrders(['show'], { url: baseUrl }, ENV)).toBe(2);
    expect(missingId.stderr()).toContain('needs an order id');

    const badStatus = capture();
    expect(await runOrders(['list'], { url: baseUrl, status: 'PAID' }, ENV)).toBe(2);
    expect(badStatus.stderr()).toContain("unknown status 'PAID'");
  });

  it('defaults the URL to http://localhost:$PORT', async () => {
    const streams = capture();
    const code = await runOrders(['list'], {}, { ADMIN_TOKEN: TOKEN, PORT: '1' });
    expect(code).toBe(1);
    expect(streams.stderr()).toContain('http://localhost:1');
  });

  it('escapes C0/C1 control characters in server-supplied text (list, show); --json stays verbatim', async () => {
    const list = capture();
    expect(await runOrders(['list'], { url: baseUrl }, ENV)).toBe(0);
    const listed = list.stdout();
    expect(listed).toContain('Ann\\x1b[2K\\x1b[1A\\x1b]52;c;eA==\\x07');
    expect(listed).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);

    const show = capture();
    expect(await runOrders(['show', hostileOrder.id], { url: baseUrl }, ENV)).toBe(0);
    const shown = show.stdout();
    expect(shown).toContain('nope\\x9b31m');
    expect(shown).toContain('note\\x1b[2J=hi\\x1b[1A');
    expect(shown).toContain('a@example.com\\x1b]8;;https://evil.example\\x07');
    expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);

    const json = capture();
    expect(await runOrders(['show', hostileOrder.id], { url: baseUrl, json: true }, ENV)).toBe(0);
    expect(JSON.parse(json.stdout())).toEqual({ order: hostileOrder });
  });

  it('refuses a non-https --url unless it is loopback, before sending the token', async () => {
    const before = requests.length;
    for (const url of ['http://book.example.com', 'http://10.0.0.5:3000', 'ftp://localhost', 'not a url']) {
      const streams = capture();
      expect(await runOrders(['list'], { url }, ENV)).toBe(2);
      expect(streams.stderr()).toMatch(/must use https|not an absolute URL/);
    }
    expect(requests.length).toBe(before);
  });

  it('never follows a redirect with the bearer token', async () => {
    const streams = capture();
    const code = await runOrders(['list'], { url: `${baseUrl}/hop` }, ENV);
    expect(code).toBe(1);
    streams.stderr();
    expect(requests.some((request) => request.path === '/stolen')).toBe(false);
  });

  it('rejects ids that are not ord_ ids (no path traversal into other admin routes)', async () => {
    const before = requests.length;
    for (const id of ['../../../x?y=', 'ord_../../admin', `ord_${'a'.repeat(23)}/`]) {
      const streams = capture();
      expect(await runOrders(['approve', id], { url: baseUrl }, ENV)).toBe(2);
      expect(streams.stderr()).toContain('is not an order id');
    }
    expect(requests.length).toBe(before);
  });
});
