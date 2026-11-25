/**
 * ACP door (2026-04-17): bearer auth (timing-safe), API-Version, Idempotency-Key rules,
 * status mapping incl. `pending_approval` + order `manual_review`, bearer-bound checkouts,
 * pending-payment recovery, and signed order webhooks (`order_create` only once an
 * authorization exists, `order_update` after; `Merchant-Signature`) delivered by
 * `deliverPendingAcpWebhooks`. Session bodies validate against the vendored official schema.
 */
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createCheckoutService } from '../checkout/index.js';
import { createAcpDoor, deliverPendingAcpWebhooks } from './index.js';
import { ACP_VERSION } from './render.js';
import { checkoutView, doorDeps, paymentsConfig, storedQuote, testQuoteId, type TestDoorDeps } from '../testing.js';
import { newId } from '../store/index.js';
import type { Order } from '../types.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const TOKEN = 'acp-token-redacted';
const SECOND_TOKEN = 'acp-second-token-redacted';
const SPT = 'spt_acp_test_redacted';
const acpPrincipal = (token: string) => createHash('sha256').update(token).digest('hex');

// ─── Vendored official schema (draft 2020-12) ────────────────────────────────

const bundle = JSON.parse(readFileSync(new URL('./schema.acp-2026-04-17.json', import.meta.url), 'utf8')) as {
  $id: string;
  $defs: Record<string, unknown>;
};

const ajv = new Ajv2020({ strict: false, formats: { uri: true, email: true, 'date-time': true } });
ajv.addSchema(bundle);
const validateSession = ajv.compile({ $ref: `${bundle.$id}#/$defs/CheckoutSessionBase` });
const validateDiscovery = ajv.compile({ $ref: `${bundle.$id}#/$defs/DiscoveryResponse` });
const validateError = ajv.compile({ $ref: `${bundle.$id}#/$defs/Error` });

/** One boundary cast: JSON from our own door under test, shaped for the assertions below. */
interface AcpTestBody {
  status?: string;
  id?: string;
  currency?: string;
  quote_id?: string;
  quote_expires_at?: string;
  messages?: Array<Record<string, unknown>>;
  order?: { id: string; status: string; permalink_url: string };
  capabilities?: { payment?: { handlers?: Array<Record<string, unknown>> } };
  buyer?: { full_name?: string; email?: string; phone_number?: string };
  line_items?: Array<{ item: { id: string } }>;
  type?: string;
  code?: string;
  message?: string;
  param?: string;
  supported_versions?: string[];
}

interface CapturedPost {
  body: string;
  signature?: string;
}

let deps: TestDoorDeps;
let base: string;
let sinkUrl: string;
let server: Server;
let sink: Server;
let posts: CapturedPost[] = [];
let sinkFailures = 0;

beforeAll(async () => {
  sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (sinkFailures > 0) {
        sinkFailures -= 1;
        res.writeHead(500);
        res.end();
        return;
      }
      const header = req.headers['merchant-signature'];
      posts.push({ body: Buffer.concat(chunks).toString('utf8'), signature: typeof header === 'string' ? header : header?.[0] });
      res.writeHead(200);
      res.end();
    });
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;

  deps = await doorDeps({
    now: () => NOW,
    config: paymentsConfig({ acp: { bearerTokens: [TOKEN], webhookUrl: `${sinkUrl}/agentic_checkout/webhooks/order_events`, webhookSecret: 'whsec_acp_redacted' } }),
  });
  const door = createAcpDoor({ ...deps, checkout: createCheckoutService(deps) });
  const app = express();
  app.use(express.json());
  if (door.router) app.use(door.router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  sink.close();
});

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: AcpTestBody; headers: Record<string, string> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'api-version': ACP_VERSION,
      'idempotency-key': `key-${method}-${path}-${Math.random().toString(36).slice(2)}`,
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as AcpTestBody, headers: Object.fromEntries(response.headers) };
}

function freshQuote(): string {
  const id = newId('qt');
  deps.service.quotes.set(id, storedQuote(id, NOW));
  return id;
}

const createBody = (itemId: string) => ({ line_items: [{ id: itemId }], buyer: { email: 'buyer@example.com' }, currency: 'usd', capabilities: {} });
const completeBody = () => ({
  buyer: { email: 'buyer@example.com', full_name: 'Dana Buyer' },
  payment_data: { handler_id: 'card_tokenized', instrument: { type: 'card', credential: { type: 'spt', token: SPT } } },
});

async function createSession(itemId?: string): Promise<string> {
  const response = await call('POST', '/acp/checkout_sessions', createBody(itemId ?? freshQuote()));
  expect(response.status).toBe(201);
  return response.body.id as string;
}

describe('ACP discovery and protocol guards', () => {
  it('GET /.well-known/acp.json is public and validates against the official schema', async () => {
    const response = await fetch(`${base}/.well-known/acp.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { protocol?: { name?: string; version?: string; supported_versions?: string[] }; api_base_url?: string };
    expect(validateDiscovery(body)).toBe(true);
    expect(body.protocol).toMatchObject({ name: 'acp', version: ACP_VERSION, supported_versions: [ACP_VERSION] });
    expect(body.api_base_url).toBe('https://pay.example/acp');
  });

  it('missing or wrong bearer → 401 protocol Error', async () => {
    const missing = await fetch(`${base}/acp/checkout_sessions`, { method: 'GET' });
    expect(missing.status).toBe(401);
    expect(validateError(await missing.json())).toBe(true);
    const wrong = await fetch(`${base}/acp/checkout_sessions`, { method: 'GET', headers: { authorization: 'Bearer nope', 'api-version': ACP_VERSION } });
    expect(wrong.status).toBe(401);
  });

  it('API-Version missing/wrong → 400 with supported_versions', async () => {
    const response = await fetch(`${base}/acp/checkout_sessions/none`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as AcpTestBody;
    expect(body.code).toBe('missing_api_version');
    expect(body.supported_versions).toEqual([ACP_VERSION]);
    const wrong = await fetch(`${base}/acp/checkout_sessions/none`, { headers: { authorization: `Bearer ${TOKEN}`, 'api-version': '2025-09-29' } });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as AcpTestBody).code).toBe('unsupported_api_version');
  });

  it('POST without Idempotency-Key → 400 idempotency_key_required', async () => {
    const response = await fetch(`${base}/acp/checkout_sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'api-version': ACP_VERSION },
      body: JSON.stringify(createBody(freshQuote())),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as AcpTestBody).code).toBe('idempotency_key_required');
  });
});

describe('ACP checkout sessions', () => {
  it('unknown item id → 400 protocol Error with the recoverable quote_required guidance; no session, no idempotency record', async () => {
    const idempotency = deps.store.collection('acp_idempotency');
    const recordsBefore = idempotency.list().length;
    const sessionsBefore = deps.store.collection('checkouts').list().length;
    for (const itemId of ['surf-lesson', 'x'.repeat(3000), newId('qt')]) {
      const response = await call('POST', '/acp/checkout_sessions', createBody(itemId));
      expect(response.status).toBe(400);
      expect(validateError(response.body)).toBe(true);
      expect(response.body).toMatchObject({ type: 'invalid_request', code: 'quote_required', param: '$.line_items[0].id' });
      expect(response.body.message).toContain('scope_offering');
    }
    expect(idempotency.list()).toHaveLength(recordsBefore);
    expect(deps.store.collection('checkouts').list()).toHaveLength(sessionsBefore);
  });

  it('the 4th session on one quote → 409 too_many_checkouts protocol Error', async () => {
    const quoteId = freshQuote();
    for (let i = 0; i < 3; i++) await createSession(quoteId);
    const response = await call('POST', '/acp/checkout_sessions', createBody(quoteId));
    expect(response.status).toBe(409);
    expect(validateError(response.body)).toBe(true);
    expect(response.body.code).toBe('too_many_checkouts');
  });

  it('update to a junk item → 400 and unchanged; a buyer-only update keeps the line items', async () => {
    const quoteId = freshQuote();
    const id = await createSession(quoteId);
    const junk = await call('POST', `/acp/checkout_sessions/${id}`, { line_items: [{ id: 'y'.repeat(3000) }] });
    expect(junk.status).toBe(400);
    expect(validateError(junk.body)).toBe(true);
    const buyerOnly = await call('POST', `/acp/checkout_sessions/${id}`, { buyer: { email: 'new@example.com' } });
    expect(buyerOnly.status).toBe(200);
    expect(validateSession(buyerOnly.body)).toBe(true);
    expect(buyerOnly.body.status).toBe('ready_for_payment');
    expect(buyerOnly.body.line_items?.[0]?.item.id).toBe(quoteId);
  });

  it('buyer fields lose terminal control sequences before they are stored', async () => {
    const response = await call('POST', '/acp/checkout_sessions', {
      ...createBody(freshQuote()),
      buyer: { full_name: '\u001b[2J\u001b[HDana\u0085 Buyer', email: 'dana@example.com\u001b', phone_number: '+1\u0000555' },
    });
    expect(response.status).toBe(201);
    expect(response.body.buyer).toEqual({ full_name: '[2J[HDana Buyer', email: 'dana@example.com', phone_number: '+1555' });
  });

  it('updates, repeated cancels and completes on a canceled session with fresh keys store no replays', async () => {
    const idempotency = deps.store.collection('acp_idempotency');
    const id = await createSession();
    expect((await call('POST', `/acp/checkout_sessions/${id}/cancel`, {})).status).toBe(200);
    const stored = idempotency.list().length;
    for (let i = 0; i < 50; i++) {
      expect((await call('POST', `/acp/checkout_sessions/${id}/cancel`, {})).status).toBe(200);
      expect((await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody())).status).toBe(200);
      expect((await call('POST', `/acp/checkout_sessions/${id}`, { buyer: { email: `b${String(i)}@example.com` } })).status).toBe(200);
    }
    expect(idempotency.list()).toHaveLength(stored);
  });

  it('valid quote → ready_for_payment with quote_id, quote_expires_at and the tokenized-card handler', async () => {
    const quoteId = freshQuote();
    const response = await call('POST', '/acp/checkout_sessions', createBody(quoteId));
    expect(response.status).toBe(201);
    expect(validateSession(response.body)).toBe(true);
    expect(response.body.status).toBe('ready_for_payment');
    expect(response.body.quote_id).toBe(quoteId);
    expect(response.body.quote_expires_at).toBe(deps.service.quotes.get(quoteId)?.expiresAt);
    const handler = response.body.capabilities?.payment?.handlers?.[0];
    expect(handler).toMatchObject({ id: 'card_tokenized', name: 'dev.acp.tokenized.card', psp: 'stripe' });
    expect(response.body.currency).toBe('usd');
  });

  it('complete with SPT → pending_approval and order in manual_review', async () => {
    const id = await createSession();
    const response = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody());
    expect(response.status).toBe(200);
    expect(validateSession(response.body)).toBe(true);
    expect(response.body.status).toBe('pending_approval');
    expect(response.body.order?.status).toBe('manual_review');
    expect(response.body.messages?.[0]).toMatchObject({ type: 'info' });
  });

  it('complete with a wrong credential type → ready_for_payment with unsupported message, no charge', async () => {
    const id = await createSession();
    const payCallsBefore = deps.service.payCalls.length;
    const response = await call('POST', `/acp/checkout_sessions/${id}/complete`, {
      payment_data: { handler_id: 'card_tokenized', instrument: { type: 'card', credential: { type: 'wallet_token', token: 'x' } } },
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready_for_payment');
    expect(response.body.messages?.[0]).toMatchObject({ type: 'error', code: 'unsupported', resolution: 'recoverable', param: '$.payment_data.instrument.credential.token' });
    expect(deps.service.payCalls).toHaveLength(payCallsBefore);
  });

  it('declined complete → ready_for_payment with payment_declined', async () => {
    const id = await createSession();
    const original = deps.service.onPay;
    deps.service.onPay = () => ({ ok: false, error: 'payment_declined', message: 'card declined (test)' });
    const response = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody());
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready_for_payment');
    expect(response.body.messages?.[0]).toMatchObject({ type: 'error', code: 'payment_declined' });
    deps.service.onPay = original;
  });

  it('owner approves → completed with order confirmed', async () => {
    const id = await createSession();
    await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody());
    const order = Array.from(deps.service.orders.values()).at(-1) as Order;
    order.status = 'paid';
    const response = await call('GET', `/acp/checkout_sessions/${id}`);
    expect(validateSession(response.body)).toBe(true);
    expect(response.body.status).toBe('completed');
    expect(response.body.order).toMatchObject({ id: order.id, status: 'confirmed', permalink_url: `https://pay.example/orders/${order.id}` });
  });

  it('cancel while awaiting approval → canceled after voiding the hold', async () => {
    const id = await createSession();
    await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody());
    const cancelsBefore = deps.service.cancelCalls.length;
    const response = await call('POST', `/acp/checkout_sessions/${id}/cancel`, { intent_trace: { reason_code: 'other' } });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('canceled');
    expect(deps.service.cancelCalls).toHaveLength(cancelsBefore + 1);
  });

  it('unknown session id → 404 protocol Error', async () => {
    const response = await call('GET', '/acp/checkout_sessions/none');
    expect(response.status).toBe(404);
    expect(validateError(response.body)).toBe(true);
  });

  it('idempotency: replay sets Idempotent-Replayed and returns the same body; different body → 422', async () => {
    const id = await createSession();
    const key = 'acp-replay-1';
    const first = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    const replay = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const conflict = await call('POST', `/acp/checkout_sessions/${id}/complete`, { payment_data: { instrument: { type: 'card', credential: { type: 'spt', token: 'spt_other' } } } }, { 'idempotency-key': key });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('idempotency_conflict');
  });

  it('in-flight lives in-process only; a duplicate while the first runs → 409, then the same key replays', async () => {
    const id = await createSession();
    const path = `/acp/checkout_sessions/${id}/complete`;
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
      const key = 'acp-inflight-1';
      const firstCall = call('POST', path, completeBody(), { 'idempotency-key': key });
      await new Promise((resolve) => setImmediate(resolve));
      const duplicate = await call('POST', path, completeBody(), { 'idempotency-key': key });
      expect(duplicate.status).toBe(409);
      expect(duplicate.headers['retry-after']).toBe('1');
      expect(duplicate.body.code).toBe('idempotency_in_flight');
      release!();
      const first = await firstCall;
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('pending_approval');
    } finally {
      release?.();
      deps.service.payWithSpt = original;
    }
    // Nothing durable is stuck in flight: the same key replays the stored response.
    const replay = await call('POST', path, completeBody(), { 'idempotency-key': 'acp-inflight-1' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('checkouts are bound to the bearer that created them; other tokens get 404', async () => {
    const localDeps = await doorDeps({ now: () => NOW, config: paymentsConfig({ acp: { bearerTokens: [TOKEN, SECOND_TOKEN] } }) });
    const localQuote = storedQuote(testQuoteId('acptoken'), NOW);
    localDeps.service.quotes.set(localQuote.id, localQuote);
    const door = createAcpDoor({ ...localDeps, checkout: createCheckoutService(localDeps) });
    const app = express();
    app.use(express.json());
    app.use(door.router!);
    const localServer = app.listen(0, '127.0.0.1');
    await once(localServer, 'listening');
    const localBase = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
    const send = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`${localBase}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'api-version': ACP_VERSION,
          'idempotency-key': `key-${method}-${path}-${token}-${Math.random().toString(36).slice(2)}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as AcpTestBody };
    };
    try {
      const created = await send('POST', '/acp/checkout_sessions', TOKEN, createBody(localQuote.id));
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect((await send('GET', `/acp/checkout_sessions/${id}`, SECOND_TOKEN)).status).toBe(404);
      expect((await send('POST', `/acp/checkout_sessions/${id}`, SECOND_TOKEN, { buyer: { email: 'x@example.com' } })).status).toBe(404);
      expect((await send('POST', `/acp/checkout_sessions/${id}/complete`, SECOND_TOKEN, completeBody())).status).toBe(404);
      expect((await send('POST', `/acp/checkout_sessions/${id}/cancel`, SECOND_TOKEN, { intent_trace: { reason_code: 'other' } })).status).toBe(404);
      expect(localDeps.service.payCalls).toHaveLength(0);
      const owned = await send('GET', `/acp/checkout_sessions/${id}`, TOKEN);
      expect(owned.status).toBe(200);
      expect(owned.body.status).toBe('ready_for_payment');
      // The creating bearer still completes normally.
      const completed = await send('POST', `/acp/checkout_sessions/${id}/complete`, TOKEN, completeBody());
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe('pending_approval');
    } finally {
      localServer.close();
    }
  });

  it('payment_pending → 200 non-final session, recoverable retry info, same key re-runs (not replayed)', async () => {
    const id = await createSession();
    const original = deps.service.onPay;
    let pending = true;
    deps.service.onPay = (input) => {
      if (pending) {
        pending = false;
        return { ok: false, error: 'payment_pending', message: 'outcome unknown (test)' };
      }
      return original(input);
    };
    const key = 'acp-pending-1';
    const first = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ready_for_payment'); // non-final
    expect(validateSession(first.body)).toBe(true);
    expect(first.body.messages?.[0]).toMatchObject({ type: 'info', severity: 'info', resolution: 'recoverable' });
    expect(String(first.body.messages?.[0]?.content)).toContain('SAME payment token');
    expect(String(first.body.messages?.[0]?.content)).not.toContain('not charged');
    const retry = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody(), { 'idempotency-key': key });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('false'); // re-ran, was not replayed
    expect(retry.body.status).toBe('pending_approval');
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
    const id = await createSession(quoteId);
    const completed = await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody());
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

describe('ACP order webhooks', () => {
  it('complete delivers order_create (manual_review) signed with Merchant-Signature; approval delivers order_update (confirmed)', async () => {
    const id = await createSession();
    const before = posts.length;
    await call('POST', `/acp/checkout_sessions/${id}/complete`, completeBody());
    await deliverPendingAcpWebhooks({ ...deps, checkout: createCheckoutService(deps) });
    expect(posts.length).toBe(before + 1);
    const created = JSON.parse(posts.at(-1)!.body) as { type: string; data: { status: string; checkout_session_id: string } };
    expect(created.type).toBe('order_create');
    expect(created.data.status).toBe('manual_review');
    expect(created.data.checkout_session_id).toBe(id);
    const signature = posts.at(-1)!.signature ?? '';
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const timestamp = signature.slice(2, signature.indexOf(','));
    const expected = createHmac('sha256', 'whsec_acp_redacted').update(`${timestamp}.${posts.at(-1)!.body}`).digest('hex');
    expect(signature.endsWith(`v1=${expected}`)).toBe(true);

    const order = Array.from(deps.service.orders.values()).at(-1) as Order;
    order.status = 'paid';
    await deliverPendingAcpWebhooks({ ...deps, checkout: createCheckoutService(deps) });
    const updated = JSON.parse(posts.at(-1)!.body) as { type: string; data: { status: string } };
    expect(updated.type).toBe('order_update');
    expect(updated.data.status).toBe('confirmed');
    const count = posts.length;
    await deliverPendingAcpWebhooks({ ...deps, checkout: createCheckoutService(deps) });
    expect(posts.length).toBe(count);
  });

  it('failed delivery is retried after the backoff', async () => {
    posts = [];
    sinkFailures = 2;
    let clock = new Date('2026-11-20T13:00:00Z');
    const localDeps = await doorDeps({ now: () => clock, config: paymentsConfig({ acp: { bearerTokens: [TOKEN], webhookUrl: `${sinkUrl}/hooks`, webhookSecret: 'whsec_acp_redacted' } }) });
    const quote = storedQuote(testQuoteId('acpweb'), clock);
    localDeps.service.quotes.set(quote.id, quote);
    const checkout = createCheckoutService(localDeps);
    const view = checkoutView(await checkout.create({ door: 'acp', principal: acpPrincipal(TOKEN) }, { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'buyer@example.com' } }));
    await checkout.complete({ door: 'acp', principal: acpPrincipal(TOKEN) }, view.id, { credential: { ok: true, spt: SPT } });

    await deliverPendingAcpWebhooks({ ...localDeps, checkout }); // fails (1)
    expect(posts).toHaveLength(0);
    clock = new Date(clock.getTime() + 30_000);
    await deliverPendingAcpWebhooks({ ...localDeps, checkout }); // still inside the 60s backoff
    expect(posts).toHaveLength(0);
    clock = new Date(clock.getTime() + 60_000);
    await deliverPendingAcpWebhooks({ ...localDeps, checkout }); // fails (2)
    expect(posts).toHaveLength(0);
    clock = new Date(clock.getTime() + 10 * 60_000);
    await deliverPendingAcpWebhooks({ ...localDeps, checkout }); // succeeds
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body) as { type: string }).type).toBe('order_create');
  });

  it('a kept (paid) checkout never re-sends order_create after a prune pass', async () => {
    posts = [];
    let clock = new Date('2026-11-22T09:00:00Z');
    const localDeps = await doorDeps({ now: () => clock, config: paymentsConfig({ acp: { bearerTokens: [TOKEN], webhookUrl: `${sinkUrl}/hooks`, webhookSecret: 'whsec_acp_redacted' } }) });
    const quote = storedQuote(testQuoteId('acpkept'), clock);
    localDeps.service.quotes.set(quote.id, quote);
    const checkout = createCheckoutService(localDeps);
    const owner = { door: 'acp' as const, principal: acpPrincipal(TOKEN) };
    const view = checkoutView(await checkout.create(owner, { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'buyer@example.com' } }));
    await checkout.complete(owner, view.id, { credential: { ok: true, spt: SPT } });
    const order = Array.from(localDeps.service.orders.values()).at(-1) as Order;
    order.status = 'paid'; // paid checkouts are kept 90 days
    // The fake service keeps orders outside the store; mirror it so the prune pass can see it.
    await localDeps.store.insertOrder(order);
    await deliverPendingAcpWebhooks({ ...localDeps, checkout });
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body) as { type: string }).type).toBe('order_create');
    // Delivery state lives on the checkout record: a prune pass 8 days later
    // cannot drop it under a live checkout, so no later sweep re-sends
    // order_create.
    clock = new Date(clock.getTime() + 8 * 24 * 3_600_000);
    await localDeps.store.prune(clock);
    await deliverPendingAcpWebhooks({ ...localDeps, checkout });
    expect(posts).toHaveLength(1); // no duplicate order_create
    expect(checkout.getOrderEvents(view.id)).toMatchObject({ orderId: order.id, created: true });
  });

  it('belated create: first delivery fails, order then rejected → next sweep sends order_create then order_update(canceled)', async () => {
    posts = [];
    sinkFailures = 1; // the order_create attempt fails
    let clock = new Date('2026-11-24T09:00:00Z');
    const localDeps = await doorDeps({ now: () => clock, config: paymentsConfig({ acp: { bearerTokens: [TOKEN], webhookUrl: `${sinkUrl}/hooks`, webhookSecret: 'whsec_acp_redacted' } }) });
    const quote = storedQuote(testQuoteId('acplate'), clock);
    localDeps.service.quotes.set(quote.id, quote);
    const checkout = createCheckoutService(localDeps);
    const owner = { door: 'acp' as const, principal: acpPrincipal(TOKEN) };
    const view = checkoutView(await checkout.create(owner, { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'buyer@example.com' } }));
    await checkout.complete(owner, view.id, { credential: { ok: true, spt: SPT } });
    await deliverPendingAcpWebhooks({ ...localDeps, checkout }); // create fails
    expect(posts).toHaveLength(0);
    // The hold existed and was released: an authorization happened, so the order must be
    // announced even though it is no longer awaiting_approval.
    const order = Array.from(localDeps.service.orders.values()).at(-1) as Order;
    order.status = 'rejected';
    order.voidOutcome = 'rejected';
    clock = new Date(clock.getTime() + 2 * 60_000); // past the 60s backoff
    await deliverPendingAcpWebhooks({ ...localDeps, checkout });
    expect(posts).toHaveLength(2);
    const created = JSON.parse(posts[0]!.body) as { type: string; data: { status: string } };
    const updated = JSON.parse(posts[1]!.body) as { type: string; data: { status: string } };
    expect(created.type).toBe('order_create');
    expect(updated.type).toBe('order_update');
    expect(updated.data.status).toBe('canceled');
    // Settled: a further sweep sends nothing.
    const count = posts.length;
    await deliverPendingAcpWebhooks({ ...localDeps, checkout });
    expect(posts).toHaveLength(count);
  });

  it('order_create waits for an authorization: nothing while authorizing; create once held; no PII or answers in the payload', async () => {
    posts = [];
    let clock = new Date('2026-11-23T09:00:00Z');
    const localDeps = await doorDeps({ now: () => clock, config: paymentsConfig({ acp: { bearerTokens: [TOKEN], webhookUrl: `${sinkUrl}/hooks`, webhookSecret: 'whsec_acp_redacted' } }) });
    const quote = storedQuote(testQuoteId('acpauth'), clock);
    localDeps.service.quotes.set(quote.id, quote);
    const checkout = createCheckoutService(localDeps);
    const owner = { door: 'acp' as const, principal: acpPrincipal(TOKEN) };
    const view = checkoutView(await checkout.create(owner, { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'buyer@example.com' } }));
    localDeps.service.onPay = (input) => {
      const stored = localDeps.service.quotes.get(input.quoteId)!;
      const order: Order = {
        id: 'ord_acpauthorizing00000a',
        quoteId: input.quoteId,
        offering: stored.offering,
        request: stored.request,
        quote: stored.quote,
        confirmation: 'owner_approves',
        door: 'acp',
        checkoutId: input.checkoutId,
        createdAt: clock.toISOString(),
        stripe: {},
        status: 'authorizing',
        pendingHooks: [],
        version: 0,
      };
      localDeps.service.orders.set(order.id, order);
      return { ok: true, value: structuredClone(order) };
    };
    await checkout.complete(owner, view.id, { credential: { ok: true, spt: SPT } });
    await deliverPendingAcpWebhooks({ ...localDeps, checkout });
    expect(posts).toHaveLength(0); // never order_create while authorizing
    const order = Array.from(localDeps.service.orders.values()).at(-1) as Order;
    order.status = 'awaiting_approval';
    await deliverPendingAcpWebhooks({ ...localDeps, checkout });
    expect(posts).toHaveLength(1);
    const created = JSON.parse(posts[0]!.body) as { type: string; data: { status: string } };
    expect(created.type).toBe('order_create');
    expect(created.data.status).toBe('manual_review');
    const serialized = posts[0]!.body;
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('participants');
    expect(serialized).not.toContain('"request"');
  });
});
