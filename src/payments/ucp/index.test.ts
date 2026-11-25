/**
 * UCP door: REST binding + MCP tools against @ucp-js/sdk 0.5.1 (= UCP schema 2026-08-25).
 * Every checkout/error response body is schema-validated; the flow covers:
 * missing/expired quote → 400 ErrorResponse (recoverable, nothing stored), valid →
 * ready_for_complete, complete → complete_in_progress with expires_at = approval deadline,
 * decline → ready_for_complete, cancel during approval, unknown id → ucp.status error,
 * idempotency on complete/cancel (in-flight 409 while the same key runs, never a durable
 * in-flight record, only 2xx stored, keys ≤ 255 chars), and a junk flood that must not grow
 * payments.json.
 */
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CheckoutResponseSchema, ErrorResponseSchema, UcpProfileDocumentSchema } from '@ucp-js/sdk';
import { createCheckoutService } from '../checkout/index.js';
import { createUcpDoor } from './index.js';
import { STRIPE_HANDLER_ID } from './render.js';
import { doorDeps, storedQuote, type TestDoorDeps } from '../testing.js';
import { PaymentsStore, newId } from '../store/index.js';
import type { Order } from '../types.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const SPT = 'spt_ucp_test_redacted';

const completeBody = (spt = SPT) => ({
  payment: {
    instruments: [
      { id: 'card_1', selected: true, handler_id: STRIPE_HANDLER_ID, type: 'card', credential: { type: 'stripe_payment_token', token: spt } },
    ],
  },
});

const createBody = (itemId: string, buyerEmail?: string) => ({
  line_items: [{ item: { id: itemId }, quantity: 1 }],
  ...(buyerEmail ? { buyer: { email: buyerEmail } } : {}),
});

/** One boundary cast: JSON from our own door under test, shaped for the assertions below. */
interface UcpTestBody {
  status?: string;
  id?: string;
  currency?: string;
  expires_at?: string;
  continue_url?: string;
  messages?: Array<Record<string, unknown>>;
  totals?: Array<{ type: string; amount: number }>;
  order?: { id: string; permalink_url: string };
  links?: Array<unknown>;
  ucp?: {
    version?: string;
    status?: string;
    services?: Record<string, Array<{ transport: string; endpoint: string }>>;
    payment_handlers?: Record<string, Array<Record<string, unknown>>>;
    capabilities?: Record<string, Array<{ version: string }>>;
  };
}

let deps: TestDoorDeps;
let base: string;
let server: Server;
beforeAll(async () => {
  deps = await doorDeps({ now: () => NOW });
  const checkout = createCheckoutService(deps);
  const door = createUcpDoor({ ...deps, checkout });
  const app = express();
  app.use(express.json());
  if (door.router) app.use(door.router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: UcpTestBody; headers: Record<string, string> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as UcpTestBody, headers: Object.fromEntries(response.headers) };
}

/** Each test gets its own live quote: one live order per quote (docs/payments.md § The shape of a payment). */
function freshQuote(): string {
  const id = newId('qt');
  deps.service.quotes.set(id, storedQuote(id, NOW));
  return id;
}

async function createCheckout(itemId?: string): Promise<string> {
  const response = await call('POST', '/ucp/checkout-sessions', createBody(itemId ?? freshQuote(), 'buyer@example.com'));
  expect(response.status).toBe(201);
  return response.body.id as string;
}

/** Fresh door per call (stateless; the store carries replayed responses). */
const tool = (name: string) => {
  const found = createUcpDoor({ ...deps, checkout: createCheckoutService(deps) }).mcpTools?.find((entry) => entry.tool.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

/** One door, many calls: the in-process in-flight map is per door, so these tests share it. */
const doorTools = () => {
  const door = createUcpDoor({ ...deps, checkout: createCheckoutService(deps) });
  return (name: string) => {
    const found = door.mcpTools?.find((entry) => entry.tool.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };
};

describe('UCP discovery profile', () => {
  it('GET /.well-known/ucp validates against the SDK profile schema and declares the Stripe handler', async () => {
    const response = await call('GET', '/.well-known/ucp');
    expect(response.status).toBe(200);
    expect(() => UcpProfileDocumentSchema.parse(response.body)).not.toThrow();
    const handler = response.body.ucp?.payment_handlers?.['com.stripe.payments']?.[0];
    expect(handler).toMatchObject({ id: 'stripe_payments', version: '2026-06-25', available_instruments: [{ type: 'card' }] });
    expect(handler?.config).toMatchObject({ environment: 'testmode', business_profile: 'profile_test' });
    expect(response.body.ucp?.services?.['dev.ucp.shopping']?.map((s) => s.transport)).toEqual(['rest', 'mcp']);
    expect(response.body.ucp?.services?.['dev.ucp.shopping']?.[0]?.endpoint).toBe('https://pay.example/ucp');
  });
});

describe('UCP REST /ucp/checkout-sessions', () => {
  it('unknown item id → 400 ErrorResponse with the recoverable quote_required guidance at the item path; nothing stored', async () => {
    const response = await call('POST', '/ucp/checkout-sessions', createBody('surf-lesson'));
    expect(response.status).toBe(400);
    expect(() => ErrorResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.ucp?.status).toBe('error');
    expect(response.body.id).toBeUndefined();
    expect(response.body.messages?.[0]).toMatchObject({
      type: 'error',
      code: 'quote_required',
      severity: 'recoverable',
      path: "$['line_items'][0]['item']['id']",
    });
    expect(String(response.body.messages?.[0]?.content)).toContain('scope_offering');
    // The business website (or public root) — never the raw handoff template.
    expect(response.body.continue_url).toBe('https://bluesurf.example');
  });

  it('expired quote → 400 ErrorResponse with recoverable quote_expired', async () => {
    const id = newId('qt');
    const stale = storedQuote(id, NOW);
    stale.expiresAt = new Date(NOW.getTime() - 1).toISOString();
    deps.service.quotes.set(id, stale);
    const response = await call('POST', '/ucp/checkout-sessions', createBody(id));
    expect(response.status).toBe(400);
    expect(() => ErrorResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.messages?.[0]).toMatchObject({ code: 'quote_expired', severity: 'recoverable' });
  });

  it('the 4th checkout on one quote → 409 too_many_checkouts', async () => {
    const quoteId = freshQuote();
    for (let i = 0; i < 3; i++) await createCheckout(quoteId);
    const response = await call('POST', '/ucp/checkout-sessions', createBody(quoteId, 'buyer@example.com'));
    expect(response.status).toBe(409);
    expect(() => ErrorResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.messages?.[0]).toMatchObject({ code: 'too_many_checkouts', severity: 'recoverable' });
  });

  it('buyer names/phones lose terminal control sequences before they are stored', async () => {
    const response = await call('POST', '/ucp/checkout-sessions', {
      line_items: [{ item: { id: freshQuote() }, quantity: 1 }],
      buyer: { first_name: '\u001b[1A\u001b[2KAda', last_name: 'Buyer\u0007', email: 'ada@example.com\u009b', phone_number: '\u001b]8;;https://evil.example\u0007+1555' },
    });
    expect(response.status).toBe(201);
    expect(CheckoutResponseSchema.parse(response.body).buyer).toEqual({ first_name: '[1A[2KAda Buyer', email: 'ada@example.com', phone_number: ']8;;https://evil.example+1555' });
  });

  it('malformed body → 400 ErrorResponse', async () => {
    const response = await call('POST', '/ucp/checkout-sessions', {});
    expect(response.status).toBe(400);
    expect(() => ErrorResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.ucp?.status).toBe('error');
  });

  it('valid quote → ready_for_complete with envelope, frozen totals and pay continue_url', async () => {
    const quoteId = freshQuote();
    const id = await createCheckout(quoteId);
    const response = await call('GET', `/ucp/checkout-sessions/${id}`);
    expect(response.status).toBe(200);
    expect(() => CheckoutResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.status).toBe('ready_for_complete');
    expect(response.body.currency).toBe('USD');
    expect(response.body.totals?.map((t) => t.type)).toEqual(['subtotal', 'total']);
    expect(response.body.totals?.find((t) => t.type === 'total')?.amount).toBe(7300);
    expect(response.body.continue_url).toBe(`https://pay.example/quotes/${quoteId}/pay`);
    expect(response.body.ucp).toMatchObject({
      version: '2026-08-25',
      status: 'success',
      payment_handlers: { 'com.stripe.payments': [{ id: 'stripe_payments' }] },
      capabilities: { 'dev.ucp.shopping.checkout': [{ version: '2026-08-25' }] },
    });
    expect(response.body.links?.length).toBeGreaterThan(0);
  });

  it('update replaces the buyer; PUT of a bad item id → 400, checkout unchanged; fixed id is ready again', async () => {
    const id = await createCheckout();
    const updated = await call('PUT', `/ucp/checkout-sessions/${id}`, createBody('offering-not-a-quote', 'buyer@example.com'));
    expect(updated.status).toBe(400);
    expect(() => ErrorResponseSchema.parse(updated.body)).not.toThrow();
    expect(updated.body.messages?.[0]).toMatchObject({ code: 'quote_required', severity: 'recoverable' });
    expect((await call('GET', `/ucp/checkout-sessions/${id}`)).body.status).toBe('ready_for_complete');
    const fixed = await call('PUT', `/ucp/checkout-sessions/${id}`, createBody(freshQuote(), 'buyer@example.com'));
    expect(fixed.body.status).toBe('ready_for_complete');
  });

  it('an Idempotency-Key over 255 characters → 400; a 404 is never stored (the same key re-runs)', async () => {
    const id = await createCheckout();
    const long = await call('POST', `/ucp/checkout-sessions/${id}/cancel`, {}, { 'idempotency-key': 'k'.repeat(256) });
    expect(long.status).toBe(400);
    expect(long.body.messages?.[0]?.code).toBe('invalid_idempotency_key');
    const store = deps.store.collection('ucp_idempotency');
    const before = store.list().length;
    const missing = await call('POST', '/ucp/checkout-sessions/chk_missing/cancel', {}, { 'idempotency-key': 'ucp-404-1' });
    expect(missing.status).toBe(404);
    expect(store.list()).toHaveLength(before);
  });

  it('complete with SPT → complete_in_progress and expires_at = approval deadline', async () => {
    const id = await createCheckout();
    const response = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-key-1' });
    expect(response.status).toBe(200);
    expect(() => CheckoutResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.status).toBe('complete_in_progress');
    const order = Array.from(deps.service.orders.values()).at(-1) as Order;
    expect(response.body.expires_at).toBe(order.approvalDeadline);
    expect(response.body.messages?.[0]).toMatchObject({ type: 'info', code: 'awaiting_approval' });
    expect(String(response.body.messages?.[0]?.content)).toContain('waiting for the business to approve');
  });

  it('complete with a wrong credential type stays ready_for_complete with recoverable unsupported_instrument', async () => {
    const id = await createCheckout();
    const payCallsBefore = deps.service.payCalls.length;
    const response = await call('POST', `/ucp/checkout-sessions/${id}/complete`, {
      payment: { instruments: [{ id: 'w', selected: true, handler_id: STRIPE_HANDLER_ID, type: 'card', credential: { type: 'pk_payment_token', token: 'x' } }] },
    }, { 'idempotency-key': 'ucp-key-2' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready_for_complete');
    expect(response.body.messages?.[0]).toMatchObject({ code: 'unsupported_instrument', severity: 'recoverable' });
    expect(deps.service.payCalls).toHaveLength(payCallsBefore);
  });

  it('declined complete → back to ready_for_complete with recoverable payment_declined', async () => {
    const id = await createCheckout();
    const original = deps.service.onPay;
    deps.service.onPay = () => ({ ok: false, error: 'payment_declined', message: 'card declined (test)' });
    const response = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-key-3' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready_for_complete');
    expect(response.body.messages?.[0]).toMatchObject({ code: 'payment_declined', severity: 'recoverable' });
    deps.service.onPay = original;
  });

  it('owner approves → GET returns completed with order permalink', async () => {
    const id = await createCheckout();
    await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-key-4' });
    const order = Array.from(deps.service.orders.values()).at(-1) as Order;
    order.status = 'paid';
    const response = await call('GET', `/ucp/checkout-sessions/${id}`);
    expect(response.body.status).toBe('completed');
    expect(response.body.order).toMatchObject({ id: order.id, permalink_url: `https://pay.example/orders/${order.id}` });
    expect(() => CheckoutResponseSchema.parse(response.body)).not.toThrow();
  });

  it('cancel while awaiting approval → canceled after voiding the hold', async () => {
    const id = await createCheckout();
    await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-key-5' });
    const response = await call('POST', `/ucp/checkout-sessions/${id}/cancel`, {}, { 'idempotency-key': 'ucp-key-6' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('canceled');
    expect(deps.service.cancelCalls.length).toBe(1);
  });

  it('unknown checkout id → 404 ErrorResponse with ucp.status error', async () => {
    const response = await call('GET', '/ucp/checkout-sessions/chk_missing00000000000000a');
    expect(response.status).toBe(404);
    expect(() => ErrorResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.ucp?.status).toBe('error');
    expect(response.body.messages?.[0]).toMatchObject({ severity: 'unrecoverable' });
  });

  it('idempotency: same key + body replays the stored response; different body → 409', async () => {
    const id = await createCheckout();
    const first = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-replay-1' });
    const replay = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-replay-1' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const conflict = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody('spt_other'), { 'idempotency-key': 'ucp-replay-1' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.messages?.[0]?.code).toBe('idempotency_conflict');
  });

  it('a second request with the same key while the first runs → 409 idempotency_in_flight', async () => {
    const id = await createCheckout();
    // Executor form: `Promise.withResolvers` needs lib es2024; this project compiles es2022.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = deps.service.payWithSpt;
    deps.service.payWithSpt = async (input) => {
      await gate;
      return original(input);
    };
    const key = 'ucp-inflight-1';
    const firstCall = call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers['retry-after']).toBe('1');
    expect(duplicate.body.messages?.[0]?.code).toBe('idempotency_in_flight');
    release!();
    const first = await firstCall;
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('complete_in_progress');
    deps.service.payWithSpt = original;
  });

  it('a thrown complete never leaves the key stuck; the retry executes (nothing durable in flight)', async () => {
    const id = await createCheckout();
    const key = 'ucp-throw-1';
    const original = deps.service.payWithSpt;
    let thrown = false;
    deps.service.payWithSpt = async (input) => {
      if (!thrown) {
        thrown = true;
        throw new Error('commit changed concurrently (test)');
      }
      return original(input);
    };
    const failed = await fetch(`${base}/ucp/checkout-sessions/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(completeBody()),
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const retry = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('complete_in_progress');
    deps.service.payWithSpt = original;
  });

  it('payment_pending → recoverable info to retry with the same token; same key re-runs instead of replaying', async () => {
    const id = await createCheckout();
    const key = 'ucp-pending-1';
    const original = deps.service.onPay;
    let pending = true;
    deps.service.onPay = (input) => {
      if (pending) {
        pending = false;
        return { ok: false, error: 'payment_pending', message: 'outcome unknown (test)' };
      }
      return original(input);
    };
    const first = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ready_for_complete'); // non-final
    expect(first.body.messages?.[0]).toMatchObject({ type: 'info', code: 'payment_pending' });
    expect(String(first.body.messages?.[0]?.content)).toContain('SAME payment token');
    expect(String(first.body.messages?.[0]?.content)).not.toContain('not charged');
    const retry = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('complete_in_progress'); // re-ran, was not replayed
    expect(retry.body.messages?.[0]).toMatchObject({ type: 'info', code: 'awaiting_approval' });
    deps.service.onPay = original;
  });

  it('responses carry no buyer PII or scoping answers beyond what the agent supplied', async () => {
    const quoteId = freshQuote();
    const stored = deps.service.quotes.get(quoteId)!;
    stored.request = { answers: { participants: 7, secret_answer: 'scoping-answer-canary' }, selections: {} };
    const original = deps.service.onPay;
    deps.service.onPay = (input) => {
      const result = original(input);
      if (result.ok) result.value.buyer = { name: 'Service Side Name', email: 'private@example.com', phone: '+15550001111' };
      return result;
    };
    const id = await createCheckout(quoteId);
    const completed = await call('POST', `/ucp/checkout-sessions/${id}/complete`, completeBody(), { 'idempotency-key': 'ucp-pii-1' });
    expect(completed.status).toBe(200);
    const serialized = JSON.stringify(completed.body);
    expect(serialized).not.toContain('scoping-answer-canary');
    expect(serialized).not.toContain('Service Side Name');
    expect(serialized).not.toContain('private@example.com');
    expect(serialized).not.toContain('+15550001111');
    expect((completed.body as { buyer?: { email?: string } }).buyer?.email).toBe('buyer@example.com');
    deps.service.onPay = original;
  });
});

describe('UCP MCP tools', () => {
  const meta = (idempotencyKey?: string) => ({
    'ucp-agent': { profile: 'https://agent.example/.well-known/ucp' },
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  });

  it('complete_checkout schema and description never ask for buyer.email (create/update carry it)', async () => {
    const spec = tool('complete_checkout').tool;
    const schema = spec.inputSchema as { properties?: { checkout?: { properties?: Record<string, unknown> } } };
    expect(schema.properties?.checkout?.properties && 'buyer' in schema.properties.checkout.properties).toBe(false);
    expect(spec.description).toContain('Buyer email is not taken here');
    const createSpec = JSON.stringify(tool('create_checkout').tool.inputSchema);
    expect(createSpec).toContain('buyer.email');
  });

  it('a thrown MCP complete clears in-flight; the retry with the same key executes', async () => {
    const t = doorTools();
    const created = await t('create_checkout').call({ meta: meta(), checkout: createBody(freshQuote(), 'buyer@example.com') });
    const id = (created.structuredContent as { id: string }).id;
    const original = deps.service.payWithSpt;
    let thrown = false;
    deps.service.payWithSpt = async (input) => {
      if (!thrown) {
        thrown = true;
        throw new Error('commit changed concurrently (test)');
      }
      return original(input);
    };
    const args = { meta: meta('mcp-throw-1'), id, checkout: completeBody() };
    await expect(t('complete_checkout').call(args)).rejects.toThrow('commit changed concurrently');
    const retry = await t('complete_checkout').call(args);
    expect(retry.isError).toBeUndefined();
    expect((retry.structuredContent as { status: string }).status).toBe('complete_in_progress');
    deps.service.payWithSpt = original;
  });

  it('a duplicate MCP complete while the first runs → tool error idempotency_in_flight', async () => {
    const t = doorTools();
    const created = await t('create_checkout').call({ meta: meta(), checkout: createBody(freshQuote(), 'buyer@example.com') });
    const id = (created.structuredContent as { id: string }).id;
    // Executor form: `Promise.withResolvers` needs lib es2024; this project compiles es2022.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = deps.service.payWithSpt;
    deps.service.payWithSpt = async (input) => {
      await gate;
      return original(input);
    };
    try {
      const args = { meta: meta('mcp-inflight-1'), id, checkout: completeBody() };
      const first = t('complete_checkout').call(args);
      await new Promise((resolve) => setImmediate(resolve));
      const duplicate = await t('complete_checkout').call(args);
      expect(duplicate.isError).toBe(true);
      expect((duplicate.structuredContent as { messages: Array<{ code: string }> }).messages[0]?.code).toBe('idempotency_in_flight');
      release!();
      const settled = await first;
      expect((settled.structuredContent as { status: string }).status).toBe('complete_in_progress');
    } finally {
      release?.();
      deps.service.payWithSpt = original;
    }
  });

  it('payment_pending MCP complete → info to retry with the same token; the same key re-runs', async () => {
    const t = doorTools();
    const created = await t('create_checkout').call({ meta: meta(), checkout: createBody(freshQuote(), 'buyer@example.com') });
    const id = (created.structuredContent as { id: string }).id;
    const original = deps.service.onPay;
    let pending = true;
    deps.service.onPay = (input) => {
      if (pending) {
        pending = false;
        return { ok: false, error: 'payment_pending', message: 'outcome unknown (test)' };
      }
      return original(input);
    };
    const args = { meta: meta('mcp-pending-1'), id, checkout: completeBody() };
    const first = await t('complete_checkout').call(args);
    expect(first.isError).toBeUndefined();
    expect((first.structuredContent as { status: string }).status).toBe('ready_for_complete');
    const firstMessages = (first.structuredContent as { messages: Array<{ code: string; content: string }> }).messages;
    expect(firstMessages[0]?.code).toBe('payment_pending');
    expect(firstMessages[0]?.content).toContain('SAME payment token');
    const retry = await t('complete_checkout').call(args);
    expect((retry.structuredContent as { status: string }).status).toBe('complete_in_progress');
    deps.service.onPay = original;
  });

  it('create → get → complete round trip with structuredContent validating against the SDK', async () => {
    const created = await tool('create_checkout').call({ meta: meta(), checkout: createBody(freshQuote(), 'buyer@example.com') });
    expect(created.isError).toBeUndefined();
    expect(() => CheckoutResponseSchema.parse(created.structuredContent)).not.toThrow();
    expect((created.structuredContent as { status?: string }).status).toBe('ready_for_complete');
    const id = (created.structuredContent as { id: string }).id;

    const got = await tool('get_checkout').call({ meta: meta(), id });
    expect((got.structuredContent as { id: string }).id).toBe(id);

    const completed = await tool('complete_checkout').call({ meta: meta('mcp-key-1'), id, checkout: completeBody() });
    expect((completed.structuredContent as { status: string }).status).toBe('complete_in_progress');
    expect(() => CheckoutResponseSchema.parse(completed.structuredContent)).not.toThrow();
  });

  it('complete_checkout without meta["idempotency-key"] → tool error idempotency_key_required', async () => {
    const created = await tool('create_checkout').call({ meta: meta(), checkout: createBody(freshQuote(), 'buyer@example.com') });
    const result = await tool('complete_checkout').call({ meta: meta(), id: (created.structuredContent as { id: string }).id, checkout: completeBody() });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { messages: Array<{ code: string }> }).messages[0]?.code).toBe('idempotency_key_required');
  });

  it('meta["ucp-agent"] accepted when missing; unknown id → ErrorResponse with ucp.status error', async () => {
    const result = await tool('get_checkout').call({ id: 'chk_missing00000000000000a' });
    expect(result.isError).toBe(true);
    expect(() => ErrorResponseSchema.parse(result.structuredContent)).not.toThrow();
    expect((result.structuredContent as { ucp: { status: string } }).ucp.status).toBe('error');
  });

  it('cancel_checkout replays identical arguments under the same idempotency key', async () => {
    const created = await tool('create_checkout').call({ meta: meta(), checkout: createBody(freshQuote(), 'buyer@example.com') });
    const id = (created.structuredContent as { id: string }).id;
    const args = { meta: meta('mcp-cancel-1'), id };
    const first = await tool('cancel_checkout').call(args);
    const replay = await tool('cancel_checkout').call(args);
    expect(replay.structuredContent).toEqual(first.structuredContent);
    expect((replay.structuredContent as { status: string }).status).toBe('canceled');
  });

  it('create_checkout with an unknown quote → tool error ErrorResponse, nothing stored', async () => {
    const t = doorTools();
    const before = deps.store.collection('checkouts').list().length;
    const result = await t('create_checkout').call({ meta: meta(), checkout: createBody(`qt_${'z'.repeat(24)}`, 'buyer@example.com') });
    expect(result.isError).toBe(true);
    expect(ErrorResponseSchema.parse(result.structuredContent).messages[0]).toMatchObject({ code: 'quote_required', severity: 'recoverable' });
    expect(deps.store.collection('checkouts').list()).toHaveLength(before);
  });

  it('MCP idempotency keys over 255 characters are refused; a not-found cancel is never stored', async () => {
    const t = doorTools();
    const long = await t('cancel_checkout').call({ meta: meta('k'.repeat(256)), id: 'chk_missing' });
    expect(long.isError).toBe(true);
    expect(ErrorResponseSchema.parse(long.structuredContent).messages[0]?.code).toBe('invalid_idempotency_key');
    const before = deps.store.collection('ucp_idempotency').list().length;
    const missing = await t('cancel_checkout').call({ meta: meta('mcp-404-1'), id: 'chk_missing' });
    expect(missing.isError).toBe(true);
    expect(deps.store.collection('ucp_idempotency').list()).toHaveLength(before);
  });
});

describe('an anonymous flood never grows payments.json', () => {
  /** The UCP door on a real file store, one legitimate checkout created (so payments.json exists). */
  async function fileServer() {
    const dir = await mkdtemp(path.join(tmpdir(), 'scopegraph-ucp-flood-'));
    const fileDeps: TestDoorDeps = { ...(await doorDeps({ now: () => NOW })), store: await PaymentsStore.open(dir) };
    const door = createUcpDoor({ ...fileDeps, checkout: createCheckoutService(fileDeps) });
    const app = express();
    app.use(express.json());
    app.use(door.router!);
    const local = app.listen(0, '127.0.0.1');
    await once(local, 'listening');
    const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    const send = async (method: string, route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const quoteId = newId('qt');
    fileDeps.service.quotes.set(quoteId, storedQuote(quoteId, NOW));
    const legit = await send('POST', '/ucp/checkout-sessions', createBody(quoteId, 'buyer@example.com'));
    expect(legit.status).toBe(201);
    const legitId = CheckoutResponseSchema.parse(await legit.json()).id;
    const size = async (): Promise<number> => {
      await fileDeps.store.flush();
      return (await stat(path.join(dir, 'payments.json'))).size;
    };
    const close = async (): Promise<void> => {
      local.close();
      await fileDeps.store.close();
      await rm(dir, { recursive: true, force: true });
    };
    return { fileDeps, door, send, legitId, size, close };
  }

  it('junk creates, updates, cancels and MCP calls leave payments.json the same size', async () => {
    const { fileDeps, door, send, legitId, size, close } = await fileServer();
    try {
      const before = await size();
      const expired = newId('qt');
      fileDeps.service.quotes.set(expired, { ...storedQuote(expired, NOW), expiresAt: new Date(NOW.getTime() - 1).toISOString() });
      const junkItems = Array.from({ length: 10 }, () => ({ item: { id: 'x'.repeat(3000) }, quantity: 1 }));
      const createTool = door.mcpTools?.find((entry) => entry.tool.name === 'create_checkout');
      const statuses = new Set<number>();
      for (let i = 0; i < 40; i++) {
        statuses.add((await send('POST', '/ucp/checkout-sessions', { line_items: junkItems })).status);
        statuses.add((await send('POST', '/ucp/checkout-sessions', createBody(newId('qt'), 'a'.repeat(3000)))).status);
        statuses.add((await send('POST', '/ucp/checkout-sessions', createBody(expired))).status);
        statuses.add((await send('PUT', `/ucp/checkout-sessions/${legitId}`, { line_items: junkItems.slice(0, 1), buyer: { first_name: 'z'.repeat(3000) } })).status);
        statuses.add((await send('POST', `/ucp/checkout-sessions/chk_${'y'.repeat(3000)}/cancel`, {}, { 'idempotency-key': `flood-cancel-${String(i)}` })).status);
        statuses.add((await send('POST', `/ucp/checkout-sessions/chk_${'y'.repeat(100)}/complete`, completeBody(), { 'idempotency-key': `flood-complete-${String(i)}` })).status);
        const tool = await createTool?.call({ checkout: { line_items: junkItems.slice(0, 1) } });
        expect(tool?.isError).toBe(true);
      }
      expect([...statuses].sort()).toEqual([400, 404]);
      expect(await size()).toBe(before);
    } finally {
      await close();
    }
  });

  it('once canceled, 200 cancels/completes with fresh keys (REST and MCP) store nothing more', async () => {
    const { door, send, legitId, size, close } = await fileServer();
    try {
      const first = await send('POST', `/ucp/checkout-sessions/${legitId}/cancel`, {}, { 'idempotency-key': 'cancel-0' });
      expect(first.status).toBe(200);
      const afterCancel = await size();
      const cancelTool = door.mcpTools?.find((entry) => entry.tool.name === 'cancel_checkout');
      const completeTool = door.mcpTools?.find((entry) => entry.tool.name === 'complete_checkout');
      for (let i = 1; i <= 200; i++) {
        expect((await send('POST', `/ucp/checkout-sessions/${legitId}/cancel`, {}, { 'idempotency-key': `cancel-${String(i)}` })).status).toBe(200);
        expect((await send('POST', `/ucp/checkout-sessions/${legitId}/complete`, completeBody(), { 'idempotency-key': `complete-${String(i)}` })).status).toBe(200);
        if (i % 10 === 0) {
          await cancelTool?.call({ meta: { 'idempotency-key': `mcp-cancel-${String(i)}` }, id: legitId });
          await completeTool?.call({ meta: { 'idempotency-key': `mcp-complete-${String(i)}` }, id: legitId, checkout: completeBody() });
        }
      }
      expect(await size()).toBe(afterCancel);
      // The state-changing cancel still replays under its own key.
      const replay = await send('POST', `/ucp/checkout-sessions/${legitId}/cancel`, {}, { 'idempotency-key': 'cancel-0' });
      expect(CheckoutResponseSchema.parse(await replay.json()).status).toBe('canceled');
    } finally {
      await close();
    }
  });
});
