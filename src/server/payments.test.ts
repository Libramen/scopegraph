import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Business } from '../graph/types.js';
import { createApp } from './app.js';
import { createScopeMcpServer } from './mcp.js';
import { loadPaymentsConfig, paymentsReloadConflict, setupPayments } from '../payments/index.js';
import type { PaymentsHandle } from '../payments/index.js';
import { PaymentsStore } from '../payments/store/index.js';
import { FakeGateway } from '../payments/stripe/index.js';
import { lessonGraph, testConfig } from '../payments/orders/test-harness.js';
import type { PaymentsConfig, PublicOrder } from '../payments/types.js';
import { signApprovalToken } from '../payments/approval/index.js';

const WEBHOOK_SECRET = 'whsec_0123456789abcdefABCDEF';
const ACP_TOKEN_1 = 't'.repeat(32);
const ACP_TOKEN_2 = 'u'.repeat(40);

const GOOD_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_51abc',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PUBLIC_URL: 'https://book.example.com/',
  ADMIN_TOKEN: 'a'.repeat(32),
  ORDER_SIGNING_SECRET: 's'.repeat(32),
  STRIPE_PROFILE_ID: 'profile_test_123',
};

function business(overrides: Partial<Business> = {}): Business {
  return { ...lessonGraph().business, ...overrides };
}

describe('loadPaymentsConfig (boot rules)', () => {
  const quiet = () => undefined;

  it('is disabled without STRIPE_SECRET_KEY', () => {
    expect(loadPaymentsConfig({}, business(), quiet)).toBeUndefined();
    expect(loadPaymentsConfig({ STRIPE_SECRET_KEY: '  ' }, business(), quiet)).toBeUndefined();
  });

  it('builds a config from valid env + business settings', () => {
    const config = loadPaymentsConfig({ ...GOOD_ENV, DATA_DIR: '/tmp/sg-data' }, business(), quiet);
    expect(config).toMatchObject({
      confirmation: 'owner_approves',
      approvalWindowHours: 24,
      quoteTtlMinutes: 30,
      publicUrl: 'https://book.example.com',
      stripe: { secretKey: 'sk_test_51abc', webhookSecret: WEBHOOK_SECRET, profileId: 'profile_test_123', livemode: false },
      dataDir: '/tmp/sg-data',
      mppEnabled: false,
    });
    expect(loadPaymentsConfig({ ...GOOD_ENV, STRIPE_SECRET_KEY: 'rk_live_x' }, business(), quiet)).toMatchObject({ stripe: { livemode: true } });
  });

  it.each([
    ['STRIPE_WEBHOOK_SECRET', undefined, /STRIPE_WEBHOOK_SECRET is required/],
    ['STRIPE_WEBHOOK_SECRET', 'abc', /must be whsec_ followed by at least 16 characters/],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_', /must be whsec_ followed by at least 16 characters/],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_0123456789abcde', /must be whsec_ followed by at least 16 characters/],
    ['STRIPE_SECRET_KEY', 'pk_test_x', /secret or restricted key/],
    ['PUBLIC_URL', undefined, /PUBLIC_URL is required/],
    ['PUBLIC_URL', 'http://book.example.com', /must use https/],
    ['PUBLIC_URL', 'not a url', /not a valid URL/],
    ['ADMIN_TOKEN', 'short', /ADMIN_TOKEN is required and must be at least 32/],
    ['ADMIN_TOKEN', undefined, /ADMIN_TOKEN/],
    ['ORDER_SIGNING_SECRET', 'x'.repeat(31), /ORDER_SIGNING_SECRET is required and must be at least 32 bytes/],
    ['ORDER_SIGNING_SECRET', 'a'.repeat(32), /ORDER_SIGNING_SECRET must differ from ADMIN_TOKEN/],
  ] as const)('%s=%s is a boot error', (name, value, message) => {
    const env: Record<string, string | undefined> = { ...GOOD_ENV, [name]: value };
    const result = loadPaymentsConfig(env, business(), quiet);
    expect(result !== undefined && 'error' in result ? result.error : '').toMatch(message);
  });

  it('allows plain http only for localhost', () => {
    expect(loadPaymentsConfig({ ...GOOD_ENV, PUBLIC_URL: 'http://localhost:3000' }, business(), quiet)).toMatchObject({ publicUrl: 'http://localhost:3000' });
    expect(loadPaymentsConfig({ ...GOOD_ENV, PUBLIC_URL: 'http://127.0.0.1:3000' }, business(), quiet)).toMatchObject({ publicUrl: 'http://127.0.0.1:3000' });
  });

  it('refuses a loopback PUBLIC_URL with a live key', () => {
    for (const url of ['http://localhost:3000', 'https://localhost', 'http://127.0.0.1:3000', 'https://127.0.0.2', 'http://[::1]:3000']) {
      for (const key of ['sk_live_51abc', 'rk_live_51abc']) {
        const result = loadPaymentsConfig({ ...GOOD_ENV, STRIPE_SECRET_KEY: key, PUBLIC_URL: url }, business(), quiet);
        expect(result !== undefined && 'error' in result ? result.error : '', `${key} ${url}`).toContain('PUBLIC_URL must not be a loopback address with a live Stripe key');
      }
    }
    expect(loadPaymentsConfig({ ...GOOD_ENV, STRIPE_SECRET_KEY: 'sk_live_51abc' }, business(), quiet)).toMatchObject({ stripe: { livemode: true } });
  });

  it('refuses non-two-decimal currencies', () => {
    for (const currency of ['JPY', 'KWD', 'ISK']) {
      const result = loadPaymentsConfig(GOOD_ENV, business({ currency }), quiet);
      expect(result !== undefined && 'error' in result ? result.error : '').toContain(`currency '${currency}' is not supported yet`);
    }
    expect(loadPaymentsConfig(GOOD_ENV, business({ currency: 'EUR' }), quiet)).toMatchObject({ publicUrl: 'https://book.example.com' });
  });

  it('MPP: warns and stays off with owner_approves; needs a profile id with instant', () => {
    const warnings: string[] = [];
    const config = loadPaymentsConfig({ ...GOOD_ENV, MPP_ENABLED: 'true' }, business(), (m) => warnings.push(m));
    expect(config).toMatchObject({ mppEnabled: false });
    expect(warnings.join('\n')).toContain('MPP_ENABLED ignored');
    const instant = business({ payments: { ...business().payments, confirmation: 'instant' } });
    expect(loadPaymentsConfig({ ...GOOD_ENV, MPP_ENABLED: 'true' }, instant, quiet)).toMatchObject({ mppEnabled: true });
    const noProfile = loadPaymentsConfig({ ...GOOD_ENV, MPP_ENABLED: 'true', STRIPE_PROFILE_ID: undefined }, instant, quiet);
    expect(noProfile !== undefined && 'error' in noProfile ? noProfile.error : '').toContain('STRIPE_PROFILE_ID');
  });

  it('ACP: tokens enable it; webhook url and secret go together', () => {
    expect(loadPaymentsConfig({ ...GOOD_ENV, ACP_BEARER_TOKENS: `${ACP_TOKEN_1}, ${ACP_TOKEN_2}` }, business(), quiet)).toMatchObject({ acp: { bearerTokens: [ACP_TOKEN_1, ACP_TOKEN_2] } });
    const half = loadPaymentsConfig({ ...GOOD_ENV, ACP_BEARER_TOKENS: ACP_TOKEN_1, ACP_WEBHOOK_URL: 'https://agent.example.com/hook' }, business(), quiet);
    expect(half !== undefined && 'error' in half ? half.error : '').toContain('must be set together');
    const full = { ...GOOD_ENV, ACP_BEARER_TOKENS: ACP_TOKEN_1, ACP_WEBHOOK_URL: 'https://agent.example.com/hook', ACP_WEBHOOK_SECRET: 'w'.repeat(32) };
    expect(loadPaymentsConfig(full, business(), quiet)).toMatchObject({ acp: { webhookSecret: 'w'.repeat(32) } });
  });

  it('ACP: short bearer tokens, a short webhook secret or a token equal to ADMIN_TOKEN are boot errors', () => {
    const errorOf = (env: Record<string, string>): string => {
      const result = loadPaymentsConfig({ ...GOOD_ENV, ...env }, business(), quiet);
      return result !== undefined && 'error' in result ? result.error : '';
    };
    expect(errorOf({ ACP_BEARER_TOKENS: `${ACP_TOKEN_1}, ${'v'.repeat(31)}` })).toContain('Each ACP_BEARER_TOKENS token must be at least 32 characters');
    expect(errorOf({ ACP_BEARER_TOKENS: 'a' })).toContain('Each ACP_BEARER_TOKENS token must be at least 32 characters');
    expect(errorOf({ ACP_BEARER_TOKENS: `${ACP_TOKEN_1},${GOOD_ENV.ADMIN_TOKEN}` })).toContain('ACP_BEARER_TOKENS must not contain ADMIN_TOKEN');
    expect(errorOf({ ACP_BEARER_TOKENS: ACP_TOKEN_1, ACP_WEBHOOK_URL: 'https://agent.example.com/hook', ACP_WEBHOOK_SECRET: 'x' })).toContain('ACP_WEBHOOK_SECRET must be at least 32 characters');
  });

  it('a --watch reload changing currency or the payments block is refused', () => {
    const boot = business();
    expect(paymentsReloadConflict(boot, business({ name: 'Renamed', currency: 'usd' }))).toBeUndefined();
    expect(paymentsReloadConflict(boot, business({ currency: 'JPY' }))).toContain('currency USD → JPY');
    const instant = business({ payments: { ...boot.payments, confirmation: 'instant' } });
    expect(paymentsReloadConflict(boot, instant)).toContain('payments.confirmation owner_approves → instant');
    const window = business({ payments: { ...boot.payments, approvalWindowHours: 2 } });
    expect(paymentsReloadConflict(boot, window)).toContain('payments.approvalWindowHours');
    const success = business({ payments: { ...boot.payments, successUrl: 'https://x.example/ok' } });
    expect(paymentsReloadConflict(boot, success)).toContain('payments.successUrl');
  });

  it('reports every problem at once', () => {
    const result = loadPaymentsConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }, business(), quiet);
    const error = result !== undefined && 'error' in result ? result.error : '';
    for (const name of ['STRIPE_WEBHOOK_SECRET', 'PUBLIC_URL', 'ADMIN_TOKEN', 'ORDER_SIGNING_SECRET']) expect(error).toContain(name);
  });
});

// ── HTTP + MCP integration with a FakeGateway ────────────────────────────────

const servers: Server[] = [];
const handles: PaymentsHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await Promise.all(handles.splice(0).map((h) => h.stop()));
});

async function listen(app: Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function paymentsApp(rateLimitPerMinute = 1000, config: PaymentsConfig = testConfig(), trustProxy?: string): Promise<{ base: string; payments: PaymentsHandle; gateway: FakeGateway }> {
  const gateway = new FakeGateway();
  const graph = lessonGraph();
  const payments = await setupPayments({
    getGraph: () => graph,
    config,
    gateway,
    store: await PaymentsStore.memory(),
    hooks: { onApprovalNeeded: async () => undefined, onPaid: async () => undefined, onClosed: async () => undefined },
    log: () => undefined,
  });
  handles.push(payments);
  const base = await listen(createApp({ getGraph: () => graph, payments, rateLimitPerMinute, ...(trustProxy !== undefined ? { trustProxy } : {}) }));
  return { base, payments, gateway };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

interface ScopeBody {
  status: string;
  quote?: { id?: string; expiresAt?: string; payable?: boolean; totalCents: number; currency: string };
  next?: { checkout?: string; url?: string };
}

describe('scope with payments enabled', () => {
  it('qualified + payable returns the stored quote id, expiry and next.checkout', async () => {
    const { base, payments } = await paymentsApp();
    const res = await post(`${base}/api/offerings/lesson/scope`, { answers: { participants: 2 } });
    const body = (await res.json()) as ScopeBody;
    expect(body.status).toBe('qualified');
    expect(body.quote).toMatchObject({ payable: true, totalCents: 14600, currency: 'USD' });
    expect(body.quote?.id).toMatch(/^qt_[a-z2-7]{24}$/);
    const stored = payments.store.getQuote(body.quote?.id ?? '');
    expect(stored?.expiresAt).toBe(body.quote?.expiresAt);
    expect(stored?.request).toEqual({ answers: { participants: 2 }, selections: {} });
    expect(body.next?.checkout).toContain(body.quote?.id ?? 'missing');
    expect(body.next?.checkout).toContain('create_payment_link');
    expect(body.next?.checkout).toContain('authorized now and charged only if the business approves');
  });

  it('totals below 50 minor units are payable: false with no id', async () => {
    const { base } = await paymentsApp();
    const body = (await (await post(`${base}/api/offerings/sticker/scope`, {})).json()) as ScopeBody;
    expect(body.status).toBe('qualified');
    expect(body.quote).toMatchObject({ payable: false, totalCents: 40 });
    expect(body.quote?.id).toBeUndefined();
    expect(body.next?.checkout).toBeUndefined();
  });

  it('without payments the response is unchanged and payment routes are absent', async () => {
    const graph = lessonGraph();
    const base = await listen(createApp({ getGraph: () => graph }));
    const body = (await (await post(`${base}/api/offerings/lesson/scope`, { answers: { participants: 2 } })).json()) as ScopeBody;
    expect(body.quote?.payable).toBeUndefined();
    expect(body.quote?.id).toBeUndefined();
    expect((await fetch(`${base}/admin/orders`, { headers: { authorization: `Bearer ${'a'.repeat(40)}` } })).status).toBe(404);
    expect((await post(`${base}/webhooks/stripe`, {})).status).toBe(404);
  });
});

describe('payment routes mounted by createApp', () => {
  it('the Stripe webhook receives the raw body (JSON parser skipped)', async () => {
    const { base, gateway } = await paymentsApp();
    const event = gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: 'pi_unknown', metadata: { orderId: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa' } });
    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
      body: event.body,
    });
    expect(res.status).toBe(200);
  });

  it('the rate limiter covers every public payment door (all doors enabled); the webhook is not in the public bucket', async () => {
    // Every door mounted: instant confirmation + MPP + ACP.
    const allDoors = testConfig({ confirmation: 'instant', mppEnabled: true, acp: { bearerTokens: ['tok_acp_test'] } });
    const requests: Array<[string, RequestInit]> = [
      ['/orders/ord_aaaaaaaaaaaaaaaaaaaaaaaa', {}],
      ['/ucp/checkout-sessions/chk_x', {}],
      ['/quotes/qt_x/pay', {}],
      ['/acp/checkout_sessions/chk_x', { headers: { authorization: 'Bearer tok_acp_test', 'api-version': '2026-04-17' } }],
      ['/mpp/quotes/qt_aaaaaaaaaaaaaaaaaaaaaaaa/pay', { method: 'POST' }],
      ['/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }],
    ];
    for (const [path, init] of requests) {
      // A fresh app per door: each starts with an empty bucket, so the 429 is this door's own.
      const { base } = await paymentsApp(2, allDoors);
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${base}${path}`, init)).status);
      expect(statuses.slice(0, 2), path).not.toContain(429);
      expect(statuses[2], path).toBe(429);
    }
    const { base } = await paymentsApp(2, allDoors);
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${base}/webhooks/stripe`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    }
  });

  it('public traffic cannot rate-limit the owner — approval and /admin use their own bucket', async () => {
    const { base } = await paymentsApp(2);
    for (let i = 0; i < 3; i++) await fetch(`${base}/api/offerings`);
    expect((await fetch(`${base}/api/offerings`)).status).toBe(429);
    expect((await fetch(`${base}/orders/ord_aaaaaaaaaaaaaaaaaaaaaaaa`)).status).toBe(429);
    // Uncredentialed owner-route requests on the same IP use the separate owner bucket (10× the limit) …
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await fetch(`${base}/admin/orders`, { headers: { authorization: 'Bearer wrong' } })).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await fetch(`${base}/orders/ord_aaaaaaaaaaaaaaaaaaaaaaaa/approve?t=forged`)).status).toBe(429);
  });

  it('a valid ADMIN_TOKEN or signed approval link is never rate limited', async () => {
    const { base } = await paymentsApp(2);
    const config = testConfig();
    const orderId = 'ord_aaaaaaaaaaaaaaaaaaaaaaaa';
    const token = (action: 'approve' | 'reject', expiresAt = new Date(Date.now() + 3_600_000)) =>
      encodeURIComponent(signApprovalToken({ orderId, action, expiresAt, secret: config.signingSecret }));
    // Exhaust both buckets with junk first (proxy without TRUST_PROXY: everyone shares one IP).
    for (let i = 0; i < 25; i++) await fetch(`${base}/admin/orders`);
    for (let i = 0; i < 3; i++) await fetch(`${base}/api/offerings`);
    expect((await fetch(`${base}/admin/orders`)).status).toBe(429);
    for (let i = 0; i < 30; i++) {
      expect((await fetch(`${base}/admin/orders`, { headers: { authorization: `Bearer ${config.adminToken}` } })).status).toBe(200);
    }
    const approve = token('approve');
    for (let i = 0; i < 25; i++) expect((await fetch(`${base}/orders/${orderId}/approve?t=${approve}`)).status).not.toBe(429);
    expect((await post(`${base}/orders/${orderId}/reject?t=${token('reject')}`, {})).status).not.toBe(429);
    // A token for the other action, another order, or an expired one is no credential.
    expect((await fetch(`${base}/orders/${orderId}/reject?t=${approve}`)).status).toBe(429);
    expect((await fetch(`${base}/orders/ord_bbbbbbbbbbbbbbbbbbbbbbbb/approve?t=${approve}`)).status).toBe(429);
    expect((await fetch(`${base}/orders/${orderId}/approve?t=${token('approve', new Date(Date.now() - 1000))}`)).status).toBe(429);
  });

  it('admin routes require ADMIN_TOKEN', async () => {
    const { base } = await paymentsApp();
    expect((await fetch(`${base}/admin/orders`)).status).toBe(401);
    expect((await fetch(`${base}/admin/orders`, { headers: { authorization: `Bearer ${'a'.repeat(40)}` } })).status).toBe(200);
  });
});

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe('MCP with payments', () => {
  it('lists get_order, teaches the payment loop, returns quote ids and public orders', async () => {
    const { base, payments } = await paymentsApp();
    const client = new Client({ name: 'payments-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.slice(0, 3)).toEqual(['list_offerings', 'describe_offering', 'scope_offering']);
      expect(names).toContain('get_order');
      expect(client.getInstructions()).toContain('PAYMENTS:');
      expect(client.getInstructions()).toContain('charged only when the business approves');

      const scoped = structured((await client.callTool({ name: 'scope_offering', arguments: { offering: 'lesson', answers: { participants: 2 } } })) as CallToolResult);
      const quoteId = (scoped['quote'] as { id: string }).id;
      expect(quoteId).toMatch(/^qt_/);

      const paid = await payments.service.payWithSpt({ quoteId, door: 'ucp', spt: 'spt_mcp', buyer: { name: 'Pii Person', email: 'pii@example.com' } });
      if (!paid.ok) throw new Error(paid.message);
      const got = (await client.callTool({ name: 'get_order', arguments: { order: paid.value.id } })) as CallToolResult;
      expect(got.isError).toBeFalsy();
      const order = structured(got) as unknown as PublicOrder;
      expect(order).toMatchObject({ id: paid.value.id, status: 'awaiting_approval', door: 'ucp' });
      expect(JSON.stringify(order)).not.toContain('pii@example.com');
      expect(JSON.stringify(order)).not.toContain('participants');

      for (const id of ['ord_aaaaaaaaaaaaaaaaaaaaaaaa', 'nonsense', 42]) {
        const missing = (await client.callTool({ name: 'get_order', arguments: { order: id } })) as CallToolResult;
        expect(missing.isError).toBe(true);
        expect(structured(missing)).toEqual({ error: 'not_found', message: 'Order not found.' });
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('the scoping-only server (stdio path) registers no payment tools and returns no quote ids', async () => {
    const graph = lessonGraph();
    const server = createScopeMcpServer(() => graph, false);
    const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['list_offerings', 'describe_offering', 'scope_offering']);
      expect(client.getInstructions()).not.toContain('PAYMENTS');
      const scoped = structured((await client.callTool({ name: 'scope_offering', arguments: { offering: 'lesson', answers: { participants: 2 } } })) as CallToolResult);
      expect(scoped['quote']).not.toHaveProperty('id');
      expect(scoped['quote']).not.toHaveProperty('payable');
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('payment routes: limiter normalisation and buckets', () => {
  it('path case and trailing slashes do not escape the limiter on payment routes', async () => {
    const allDoors = testConfig({ confirmation: 'instant', mppEnabled: true, acp: { bearerTokens: ['tok_acp_test'] } });
    const variants: Array<[string, RequestInit]> = [
      ['/UCP/checkout-sessions/chk_x', {}],
      ['/ucp/checkout-sessions/chk_x/', {}],
      ['/Quotes/qt_x/pay', {}],
      ['/ORDERS/ord_aaaaaaaaaaaaaaaaaaaaaaaa', {}],
      ['/Mpp/quotes/qt_aaaaaaaaaaaaaaaaaaaaaaaa/pay', { method: 'POST' }],
      ['/API/quotes/qt_x/payment-link', { method: 'POST' }],
      ['/Webhooks/Stripe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }],
    ];
    for (const [path, init] of variants) {
      const { base } = await paymentsApp(2, allDoors);
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${base}${path}`, init)).status);
      expect(statuses.slice(0, 2), path).not.toContain(429);
      expect(statuses[2], path).toBe(429);
    }
    // Uncredentialed owner routes in any spelling still land in the owner bucket (10×), not the public one.
    const { base } = await paymentsApp(2);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await fetch(`${base}/Admin/Orders/`, { headers: { authorization: 'Bearer wrong' } })).status);
    expect(statuses.slice(0, 20)).not.toContain(429);
    expect(statuses[20]).toBe(429);
  });

  it('the Stripe webhook has its own bucket of 10× the limit, untouched by public traffic', async () => {
    const { base } = await paymentsApp(2);
    for (let i = 0; i < 3; i++) await fetch(`${base}/api/offerings`);
    expect((await fetch(`${base}/api/offerings`)).status).toBe(429);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await fetch(`${base}/webhooks/stripe`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status);
    }
    // Unsigned junk is rejected by the signature check until the bucket is spent.
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('HTTP scope and MCP scope_offering pass the client IP (after trust proxy) to createQuote', async () => {
    const { base, payments } = await paymentsApp(1000, testConfig(), 'loopback');
    const createQuote = vi.spyOn(payments.scope, 'createQuote');
    const res = await fetch(`${base}/api/offerings/lesson/scope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ answers: { participants: 2 } }),
    });
    expect(((await res.json()) as ScopeBody).status).toBe('qualified');
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(createQuote.mock.calls[0]?.[3]).toBe('203.0.113.7');

    const client = new Client({ name: 'quota-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'x-forwarded-for': '203.0.113.8' } } }));
    try {
      const scoped = (await client.callTool({ name: 'scope_offering', arguments: { offering: 'lesson', answers: { participants: 2 } } })) as CallToolResult;
      expect(scoped.isError).toBeFalsy();
      expect(createQuote).toHaveBeenCalledTimes(2);
      expect(createQuote.mock.calls[1]?.[3]).toBe('203.0.113.8');
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
