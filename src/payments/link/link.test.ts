/**
 * Link door tests: routes + MCP tool against a fake OrderService.
 *
 * Covers: prefetch-safe GET (never starts an order), POST → 303 to the Stripe
 * session url (idempotent re-POST), the JSON api twin, refusal pages
 * (unknown/expired/in-use), and HTML escaping + security headers.
 */
import express from 'express';
import type { Router } from 'express';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { buildTestGraph } from '../../server/test-graph.js';
import { LockManager } from '../store/locks.js';
import type { PaymentsStore } from '../store/index.js';
import type {
  Door,
  DoorDeps,
  Order,
  OrderService,
  OrderStatus,
  PublicOrder,
  ServiceError,
  ServiceResult,
  StoredQuote,
} from '../types.js';
import { createLinkDoor } from './index.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const SESSION_URL = 'https://checkout.stripe.com/c/pay/cs_test_abc';
const SESSION_EXPIRY = '2026-11-20T12:31:00Z';
const QUOTE_ID = 'qt_aaaaaaaaaaaaaaaaaaaaaaa';

function quoteFixture(overrides: Partial<StoredQuote> = {}): StoredQuote {
  return {
    id: QUOTE_ID,
    offering: 'surf-lesson',
    request: { answers: { participants: 2 }, selections: {} },
    quote: {
      currency: 'USD',
      lines: [
        { id: 'l1', label: 'Surf lesson × 2', kind: 'base', amountCents: 14600, quantity: 2, unitAmountCents: 7300, taxable: true, source: { offering: 'surf-lesson' } },
        { id: 'l2', label: 'Epoxy board', kind: 'addon', amountCents: 1500, taxable: true, source: { offering: 'surf-lesson', option: 'board' } },
      ],
      subtotalCents: 16100,
      taxCents: 0,
      totalCents: 16100,
    },
    createdAt: NOW.toISOString(),
    expiresAt: '2026-11-20T12:30:00Z',
    ...overrides,
  };
}

function orderFixture(overrides: { id: string; quoteId: string; door: Door; status: OrderStatus } & Partial<Order>): Order {
  return {
    offering: 'surf-lesson',
    request: { answers: {}, selections: {} },
    quote: quoteFixture().quote,
    confirmation: 'owner_approves',
    createdAt: NOW.toISOString(),
    stripe: {},
    pendingHooks: [],
    version: 1,
    ...overrides,
  };
}

function linkOrder(orderId: string): Order {
  return orderFixture({
    id: orderId,
    quoteId: QUOTE_ID,
    door: 'link',
    status: 'awaiting_payment',
    stripe: { checkoutUrl: SESSION_URL, checkoutSessionExpiresAt: SESSION_EXPIRY },
  });
}

function publicOrder(order: Order): PublicOrder {
  return {
    id: order.id,
    offering: order.offering,
    status: order.status,
    confirmation: order.confirmation,
    door: order.door,
    quote: order.quote,
    statusUrl: `https://shop.example.com/orders/${order.id}`,
    ...(order.approvalDeadline ? { approvalDeadline: order.approvalDeadline } : {}),
    ...(order.stripe.checkoutUrl ? { paymentUrl: order.stripe.checkoutUrl } : {}),
  };
}

function okStart(order: Order): ServiceResult<{ order: PublicOrder; url: string }> {
  return { ok: true, value: { order: publicOrder(order), url: SESSION_URL } };
}

interface ServiceOptions {
  quotes?: StoredQuote[];
  liveOrders?: Order[];
  orders?: Order[];
  start?: (quoteId: string) => ServiceResult<{ order: PublicOrder; url: string }>;
}

/** Fake OrderService: only what this door calls; anything unused throws. */
function makeService(options: ServiceOptions): { service: OrderService; started: string[] } {
  const quotes = new Map((options.quotes ?? []).map((q) => [q.id, q]));
  const liveOrders = new Map((options.liveOrders ?? []).map((o) => [o.quoteId, o]));
  const orders = new Map((options.orders ?? []).map((o) => [o.id, o]));
  const started: string[] = [];
  const service: OrderService = {
    async createQuote() {
      throw new Error('unused');
    },
    async getQuote(id) {
      return quotes.get(id);
    },
    async startLinkOrder(quoteId) {
      started.push(quoteId);
      return options.start?.(quoteId) ?? { ok: false, error: 'quote_not_found', message: 'no start configured' };
    },
    async payWithSpt() {
      throw new Error('unused');
    },
    async approve() {
      throw new Error('unused');
    },
    async reject() {
      throw new Error('unused');
    },
    async cancel() {
      throw new Error('unused');
    },
    async getOrder(orderId) {
      return orders.get(orderId);
    },
    async getLiveOrderForQuote(quoteId) {
      return liveOrders.get(quoteId);
    },
    async listOrders() {
      throw new Error('unused');
    },
    toPublic: publicOrder,
    async handleStripeTrigger() {
      throw new Error('unused');
    },
    async reconcile() {
      throw new Error('unused');
    },
  };
  return { service, started };
}

function makeDeps(service: OrderService): DoorDeps {
  // The link door never touches the store; real lock manager, opaque ids.
  const store = { collection: () => { throw new Error('unused'); }, locks: new LockManager(), newId: (p: string) => `${p}_x` } as unknown as PaymentsStore;
  return {
    service,
    store,
    getGraph: () => buildTestGraph(),
    now: () => NOW,
    config: {
      confirmation: 'owner_approves',
      approvalWindowHours: 24,
      quoteTtlMinutes: 30,
      publicUrl: 'https://shop.example.com',
      stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x', profileId: 'cst_x', livemode: false },
      adminToken: 'a'.repeat(32),
      signingSecret: 's'.repeat(32),
      dataDir: './data',
      mppEnabled: false,
    },
  };
}

/** Mount the door on a throwaway app; run(url); report startLinkOrder calls. */
async function withDoor<T>(options: ServiceOptions, run: (url: string) => Promise<T>): Promise<{ result: T; started: string[] }> {
  const { service, started } = makeService(options);
  const door = createLinkDoor(makeDeps(service));
  const expressApp = express();
  if (door.router) expressApp.use(door.router as Router);
  const srv = expressApp.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const address = srv.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP port');
  try {
    return { result: await run(`http://127.0.0.1:${address.port}`), started };
  } finally {
    await new Promise<void>((resolve, reject) => srv.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('link door', () => {
  it('GET /quotes/:id/pay renders a prefetch-safe summary without starting an order', async () => {
    const { result, started } = await withDoor({ quotes: [quoteFixture()] }, async (url) => {
      const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`);
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    });
    expect(result.status).toBe(200);
    expect(started).toEqual([]);
    expect(result.body).toContain('Continue to secure payment');
    expect(result.body).toContain('Surf lesson × 2');
    expect(result.body).toContain('USD 146.00');
    expect(result.body).toContain('USD 161.00');
    expect(result.body).toContain(QUOTE_ID);
    expect(result.body).toContain('<form method="post"');
    expect(result.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com");
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('only the pay form page lets form-action reach Stripe Checkout', async () => {
    const csp = (res: Response): string => res.headers.get('content-security-policy') ?? '';
    const pay = await withDoor({ quotes: [quoteFixture()] }, async (url) => csp(await fetch(`${url}/quotes/${QUOTE_ID}/pay`)));
    expect(pay.result).toContain("form-action 'self' https://checkout.stripe.com");

    const others: string[] = [];
    await withDoor({}, async (url) => {
      others.push(csp(await fetch(`${url}/quotes/qt_unknown0000000000000000/pay`)));
    });
    const paidOrder = orderFixture({ id: 'ord_paid000000000000000000a', quoteId: QUOTE_ID, door: 'link', status: 'paid' });
    await withDoor({ quotes: [quoteFixture()], liveOrders: [paidOrder] }, async (url) => {
      others.push(csp(await fetch(`${url}/quotes/${QUOTE_ID}/pay`)));
    });
    await withDoor(
      { quotes: [quoteFixture()], start: () => ({ ok: false, error: 'quote_expired', message: 'expired' }) },
      async (url) => {
        others.push(csp(await fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' })));
      },
    );
    expect(others).toHaveLength(3);
    for (const header of others) {
      expect(header).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    }
  });

  it('GET escapes hostile offering/line strings', async () => {
    const quote = quoteFixture({
      offering: 'surf<script>alert(1)</script>',
      quote: {
        ...quoteFixture().quote,
        lines: [{ id: 'l1', label: '<img src=x onerror="alert(2)">', kind: 'base', amountCents: 1000, taxable: true, source: { offering: 'surf' } }],
      },
    });
    const { result } = await withDoor({ quotes: [quote] }, async (url) => {
      const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`);
      return res.text();
    });
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&lt;img');
  });

  it('GET answers 404 for an unknown quote and 410 for an expired one', async () => {
    const unknown = await withDoor({}, async (url) => fetch(`${url}/quotes/qt_unknown0000000000000000/pay`).then((r) => r.status));
    expect(unknown.result).toBe(404);

    const expired = quoteFixture({ id: 'qt_bbbbbbbbbbbbbbbbbbbbbbb', expiresAt: '2026-11-20T11:00:00Z' });
    const expiredPage = await withDoor({ quotes: [expired] }, async (url) => {
      const res = await fetch(`${url}/quotes/${expired.id}/pay`);
      return { status: res.status, body: await res.text() };
    });
    expect(expiredPage.result.status).toBe(410);
    expect(expiredPage.result.body).toContain('expired');
  });

  it('GET refuses a quote locked to another door (403) and shows paid link orders', async () => {
    const ucpOrder = orderFixture({ id: 'ord_ucp0000000000000000000', quoteId: QUOTE_ID, door: 'ucp', status: 'awaiting_approval' });
    const inUse = await withDoor({ quotes: [quoteFixture()], liveOrders: [ucpOrder] }, async (url) => {
      const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`);
      return { status: res.status, body: await res.text() };
    });
    expect(inUse.result.status).toBe(403);
    expect(inUse.result.body).toContain('another payment method');
    expect(inUse.result.body).not.toContain('No payment was taken');

    const paidOrder = orderFixture({ id: 'ord_paid000000000000000000a', quoteId: QUOTE_ID, door: 'link', status: 'paid' });
    const paid = await withDoor({ quotes: [quoteFixture()], liveOrders: [paidOrder] }, async (url) => {
      const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`);
      return { status: res.status, body: await res.text() };
    });
    expect(paid.result.status).toBe(200);
    expect(paid.result.body).toContain('already been paid');
  });

  it('POST /quotes/:id/pay 303-redirects to the Stripe url and is idempotent', async () => {
    const outcome = await withDoor(
      { quotes: [quoteFixture()], start: () => okStart(linkOrder('ord_link000000000000000000a')) },
      async (url) => {
        const first = await fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' });
        const second = await fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' });
        return {
          statuses: [first.status, second.status],
          locations: [first.headers.get('location'), second.headers.get('location')],
        };
      },
    );
    expect(outcome.started).toEqual([QUOTE_ID, QUOTE_ID]);
    expect(outcome.result.statuses).toEqual([303, 303]);
    expect(outcome.result.locations).toEqual([SESSION_URL, SESSION_URL]);
  });

  it('POST /quotes/:id/pay renders refusal pages instead of redirecting', async () => {
    const inUse = await withDoor(
      { quotes: [quoteFixture()], start: () => ({ ok: false, error: 'quote_in_use', message: 'quote is locked to ucp' }) },
      async (url) => {
        const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' });
        return { status: res.status, body: await res.text() };
      },
    );
    expect(inUse.result.status).toBe(403);
    expect(inUse.result.body).toContain('quote is locked to ucp');
    // A payment may be mid-flight on the other door: no "no payment" claim.
    expect(inUse.result.body).not.toContain('No payment was taken');

    const expired = await withDoor(
      { quotes: [quoteFixture()], start: () => ({ ok: false, error: 'quote_expired', message: 'expired' }) },
      async (url) => fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' }).then((r) => r.status),
    );
    expect(expired.result).toBe(410);
  });

  it('POST /api/quotes/:id/payment-link answers payment_pending 503 with Retry-After', async () => {
    const { result } = await withDoor(
      { quotes: [quoteFixture()], start: () => ({ ok: false, error: 'payment_pending', message: 'outcome unknown' }) },
      async (url) => {
        const res = await fetch(`${url}/api/quotes/${QUOTE_ID}/payment-link`, { method: 'POST' });
        return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as { error: string } };
      },
    );
    expect(result.status).toBe(503);
    expect(result.retryAfter).toMatch(/^\d+$/);
    expect(result.body.error).toBe('payment_pending');
  });

  it('POST page: payment_pending renders a retryable 503 page, invalid_state drops the "no payment" trailer', async () => {
    const pending = await withDoor(
      { quotes: [quoteFixture()], start: () => ({ ok: false, error: 'payment_pending', message: 'outcome unknown' }) },
      async (url) => {
        const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' });
        return { status: res.status, body: await res.text() };
      },
    );
    expect(pending.result.status).toBe(503);
    expect(pending.result.body).toContain('not confirmed yet');
    expect(pending.result.body).not.toContain('No payment was taken');

    const invalidState = await withDoor(
      { quotes: [quoteFixture()], start: () => ({ ok: false, error: 'invalid_state', message: 'Order ord_x is awaiting_approval.' }) },
      async (url) => {
        const res = await fetch(`${url}/quotes/${QUOTE_ID}/pay`, { method: 'POST', redirect: 'manual' });
        return { status: res.status, body: await res.text() };
      },
    );
    expect(invalidState.result.status).toBe(403);
    expect(invalidState.result.body).toContain('Order ord_x is awaiting_approval.');
    // A card may already be held for this quote: never claim otherwise.
    expect(invalidState.result.body).not.toContain('No payment was taken');
  });

  it('POST /api/quotes/:id/payment-link returns order, url and session expiry', async () => {
    const order = linkOrder('ord_link000000000000000000a');
    const { result } = await withDoor(
      { quotes: [quoteFixture()], orders: [order], start: () => okStart(order) },
      async (url) => {
        const res = await fetch(`${url}/api/quotes/${QUOTE_ID}/payment-link`, { method: 'POST' });
        return { status: res.status, body: (await res.json()) as { order: PublicOrder; url: string; expiresAt: string } };
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.url).toBe(SESSION_URL);
    expect(result.body.expiresAt).toBe(SESSION_EXPIRY);
    expect(result.body.order.id).toBe(order.id);
    expect(result.body.order.door).toBe('link');
  });

  it('POST /api/quotes/:id/payment-link maps service refusals to statuses', async () => {
    const cases: Array<{ error: ServiceError; status: number }> = [
      { error: 'quote_not_found', status: 404 },
      { error: 'quote_in_use', status: 409 },
      { error: 'quote_expired', status: 410 },
      { error: 'requote_required', status: 410 },
      { error: 'amount_too_small', status: 422 },
      { error: 'too_many_attempts', status: 429 },
      // Never payable-looking; startLinkOrder cannot go pending in practice.
      { error: 'payment_pending', status: 503 },
    ];
    for (const c of cases) {
      const { result } = await withDoor(
        { quotes: [quoteFixture()], start: () => ({ ok: false, error: c.error, message: 'm' }) },
        async (url) =>
          fetch(`${url}/api/quotes/${QUOTE_ID}/payment-link`, { method: 'POST' }).then(async (r) => ({ status: r.status, body: await r.json() })),
      );
      expect(result.status).toBe(c.status);
      expect(result.body).toEqual({ error: c.error, message: 'm' });
    }
  });

  it('MCP tool create_payment_link: success, refusal and invalid arguments', async () => {
    const order = linkOrder('ord_link000000000000000000a');
    const goodService = makeService({ quotes: [quoteFixture()], orders: [order], start: () => okStart(order) });
    const goodTool = createLinkDoor(makeDeps(goodService.service)).mcpTools?.[0];
    expect(goodTool?.tool.name).toBe('create_payment_link');
    const ok = await goodTool!.call({ quote: QUOTE_ID });
    expect(ok.isError).toBeUndefined();
    // Test seam: this door's payload is exactly { order, url, expiresAt }.
    const payload = ok.structuredContent as { url: string; expiresAt: string; order: PublicOrder };
    expect(payload.url).toBe(SESSION_URL);
    expect(payload.expiresAt).toBe(SESSION_EXPIRY);
    expect(payload.order.door).toBe('link');

    const badService = makeService({ quotes: [quoteFixture()], start: () => ({ ok: false, error: 'quote_in_use', message: 'locked' }) });
    const badTool = createLinkDoor(makeDeps(badService.service)).mcpTools?.[0];
    const refused = await badTool!.call({ quote: QUOTE_ID });
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: string }).error).toBe('quote_in_use');

    const invalid = await badTool!.call({});
    expect(invalid.isError).toBe(true);
    expect((invalid.structuredContent as { error: string }).error).toBe('invalid_arguments');
  });
});

describe('create_payment_link description', () => {
  it('promises approval-gated capture only under owner_approves', () => {
    const description = (confirmation: 'instant' | 'owner_approves') =>
      createLinkDoor({ config: { confirmation } } as unknown as DoorDeps).mcpTools![0]!.tool.description ?? '';
    expect(description('instant')).not.toMatch(/approv/i);
    expect(description('instant')).toContain('charged when the buyer completes payment');
    expect(description('owner_approves')).toContain('only captured once the business approves');
  });
});
