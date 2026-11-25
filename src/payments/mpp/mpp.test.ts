/**
 * MPP door tests: 402 challenge contents, credential round trip with mppx's
 * own client helpers, single-use challenges, the 404/403/200/503 route
 * semantics (503 `payment_pending` = unknown outcome), and a retry after an
 * ambiguous create against the REAL OrderService + FakeGateway — all against
 * a fake OrderService unless stated.
 */
import express from 'express';
import type { Router } from 'express';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Mppx as MppxClient, stripe } from 'mppx/client';
import { buildTestGraph } from '../../server/test-graph.js';
import { LockManager } from '../store/locks.js';
import type { PaymentsStore } from '../store/index.js';
import type {
  Buyer,
  Door,
  DoorDeps,
  Order,
  OrderService,
  OrderStatus,
  PublicOrder,
  ServiceResult,
  StoredQuote,
} from '../types.js';
import { makeHarness } from '../orders/test-harness.js';
import { createMppDoor, mppSecretKey } from './index.js';

// mppx checks challenge expiry against the wall clock, so the injected clock
// must be "now" too — a fixed date turns every challenge into an expired one
// once the calendar passes it.
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const minutesFromNow = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const QUOTE_ID = 'qt_aaaaaaaaaaaaaaaaaaaaaaa';
const SPT = 'spt_test_1234';

function quoteFixture(overrides: Partial<StoredQuote> = {}): StoredQuote {
  return {
    id: QUOTE_ID,
    offering: 'surf-lesson',
    request: { answers: { participants: 2 }, selections: {} },
    quote: {
      currency: 'USD',
      lines: [
        { id: 'l1', label: 'Surf lesson × 2', kind: 'base', amountCents: 9250, quantity: 2, unitAmountCents: 4625, taxable: true, source: { offering: 'surf-lesson' } },
      ],
      subtotalCents: 9250,
      taxCents: 0,
      totalCents: 9250,
    },
    createdAt: NOW.toISOString(),
    expiresAt: minutesFromNow(30),
    ...overrides,
  };
}

function orderFixture(overrides: { id: string; quoteId: string; door: Door; status: OrderStatus } & Partial<Order>): Order {
  return {
    offering: 'surf-lesson',
    request: { answers: {}, selections: {} },
    quote: quoteFixture().quote,
    confirmation: 'instant',
    createdAt: NOW.toISOString(),
    stripe: {},
    pendingHooks: [],
    version: 1,
    ...overrides,
  };
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
  };
}

interface ServiceOptions {
  quotes?: StoredQuote[];
  liveOrders?: Order[];
  /** Scripted `payWithSpt` results, popped per call (repeats the last one). */
  pay?: Array<ServiceResult<Order> | Error>;
}

/** Fake OrderService: only what this door calls; anything unused throws. */
function makeService(options: ServiceOptions): { service: OrderService; paid: Array<{ quoteId: string; spt: string; requireSettled?: boolean }> } {
  const quotes = new Map((options.quotes ?? []).map((q) => [q.id, q]));
  const liveOrders = new Map((options.liveOrders ?? []).map((o) => [o.quoteId, o]));
  const script = [...(options.pay ?? [])];
  const paid: Array<{ quoteId: string; spt: string; requireSettled?: boolean }> = [];
  const service: OrderService = {
    async createQuote() {
      throw new Error('unused');
    },
    async getQuote(id) {
      return quotes.get(id);
    },
    async startLinkOrder() {
      throw new Error('unused');
    },
    async payWithSpt(input: { quoteId: string; spt: string; requireSettled?: boolean; buyer?: Buyer }) {
      paid.push({ quoteId: input.quoteId, spt: input.spt, requireSettled: input.requireSettled });
      const next = script.length > 1 ? script.shift() : script[0];
      if (next === undefined) throw new Error('no pay script');
      if (next instanceof Error) throw next;
      return next;
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
    async getOrder() {
      throw new Error('unused');
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
  return { service, paid };
}

function makeDeps(service: OrderService): DoorDeps {
  // The MPP door never touches the store; real lock manager, opaque ids.
  const store = { collection: () => { throw new Error('unused'); }, locks: new LockManager(), newId: (p: string) => `${p}_x` } as unknown as PaymentsStore;
  return {
    service,
    store,
    getGraph: () => buildTestGraph(),
    now: () => NOW,
    config: {
      confirmation: 'instant',
      approvalWindowHours: 24,
      quoteTtlMinutes: 30,
      publicUrl: 'https://shop.example.com',
      stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x', profileId: 'cst_network', livemode: false },
      adminToken: 'a'.repeat(32),
      signingSecret: 's'.repeat(32),
      dataDir: './data',
      mppEnabled: true,
    },
  };
}

function paidResult(): ServiceResult<Order> {
  return {
    ok: true,
    value: orderFixture({ id: 'ord_mpp0000000000000000000a', quoteId: QUOTE_ID, door: 'mpp', status: 'paid', stripe: { paymentIntentId: 'pi_test_1' } }),
  };
}

/** Mount any DoorDeps on a throwaway app. */
async function withDeps<T>(deps: DoorDeps, run: (url: string) => Promise<T>): Promise<T> {
  const door = createMppDoor(deps);
  const expressApp = express();
  if (door.router) expressApp.use(door.router as Router);
  const srv = expressApp.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const address = srv.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP port');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => srv.close((error) => (error ? reject(error) : resolve())));
  }
}

/** Mount the MPP door on a throwaway app; run(url); report payWithSpt calls. */
async function withDoor<T>(options: ServiceOptions, run: (url: string) => Promise<T>): Promise<{ result: T; paid: Array<{ quoteId: string; spt: string; requireSettled?: boolean }> }> {
  const { service, paid } = makeService(options);
  const result = await withDeps(makeDeps(service), run);
  return { result, paid };
}

/** mppx client with a fake SPT minter — the real 402 → credential → 200 loop. */
function mppxClient() {
  return MppxClient.create({
    methods: [stripe({ createToken: async () => SPT, paymentMethod: 'pm_card_visa' })],
  });
}

describe('mpp door', () => {
  it('mppSecretKey is a stable ≥32-byte derivation, not the signing secret', () => {
    expect(mppSecretKey('s'.repeat(32))).toMatch(/^[0-9a-f]{64}$/);
    expect(mppSecretKey('s'.repeat(32))).toBe(mppSecretKey('s'.repeat(32)));
    expect(mppSecretKey('s'.repeat(32))).not.toBe('s'.repeat(32));
  });

  it('answers 402 with a stripe charge challenge bound to the frozen quote', async () => {
    const quote = quoteFixture();
    const { result } = await withDoor({ quotes: [quote] }, async (url) => {
      const client = mppxClient();
      const response = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      const payment = await client.preparePayment(response, { request: { method: 'POST' } });
      return {
        status: response.status,
        wwwAuthenticate: response.headers.get('www-authenticate'),
        challenge: payment.challenge,
      };
    });
    expect(result.status).toBe(402);
    expect(result.wwwAuthenticate?.startsWith('Payment')).toBe(true);
    const challenge = result.challenge;
    expect(challenge.method).toBe('stripe');
    expect(challenge.intent).toBe('charge');
    expect(challenge.realm).toBe('shop.example.com');
    // Amount/currency come from the stored quote, never the caller.
    expect(String(challenge.request.amount)).toBe('9250');
    expect(String(challenge.request.currency).toLowerCase()).toBe('usd');
    expect(challenge.request.externalId).toBe(QUOTE_ID);
    expect(Date.parse(String(challenge.expires))).toBeGreaterThan(NOW.getTime());
    expect(Date.parse(String(challenge.expires))).toBeLessThanOrEqual(Date.parse(quote.expiresAt));
  });

  it('completes a credential round trip: 200, order JSON, Payment-Receipt, payWithSpt args', async () => {
    const quote = quoteFixture();
    const { result, paid } = await withDoor({ quotes: [quote], pay: [paidResult()] }, async (url) => {
      const client = mppxClient();
      const response = await client.fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      return {
        status: response.status,
        receipt: response.headers.get('payment-receipt'),
        body: (await response.json()) as PublicOrder,
      };
    });
    expect(result.status).toBe(200);
    expect(result.receipt).toBeTruthy();
    expect(result.body.id).toBe('ord_mpp0000000000000000000a');
    expect(result.body.status).toBe('paid');
    expect(result.body.door).toBe('mpp');
    expect(paid).toEqual([{ quoteId: QUOTE_ID, spt: SPT, requireSettled: true }]);
  });

  it('consumes challenges single-use: a replayed credential gets a fresh 402, never a second charge', async () => {
    const quote = quoteFixture();
    const refusal: ServiceResult<Order> = { ok: false, error: 'payment_declined', message: 'card declined' };
    const { result, paid } = await withDoor({ quotes: [quote], pay: [refusal] }, async (url) => {
      const client = mppxClient();
      const challengeResponse = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      const payment = await client.preparePayment(challengeResponse, { request: { method: 'POST' } });
      const credential = await payment.createCredential();
      const init = payment.setCredential({ method: 'POST' }, credential);
      // First use: definitive refusal → 403 problem+json, claim consumed.
      const first = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, init);
      // Replay of the SAME credential: the claim map must reject it with a
      // fresh 402 challenge rather than calling the service again.
      const replay = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, init);
      const retryPayment = await client.preparePayment(replay, { request: { method: 'POST' } });
      return {
        firstStatus: first.status,
        replayStatus: replay.status,
        replayChallengeId: retryPayment.challenge.id,
        originalChallengeId: payment.challenge.id,
      };
    });
    expect(result.firstStatus).toBe(403);
    expect(result.replayStatus).toBe(402);
    expect(result.replayChallengeId).not.toBe(result.originalChallengeId);
    expect(paid).toHaveLength(1);
  });

  it('404 for an unknown quote, 403 problem+json for expired and in-use quotes', async () => {
    const unknown = await withDoor({}, async (url) => {
      const res = await fetch(`${url}/mpp/quotes/qt_unknown0000000000000000/pay`, { method: 'POST' });
      return { status: res.status, type: res.headers.get('content-type') };
    });
    expect(unknown.result.status).toBe(404);

    const expired = quoteFixture({ id: 'qt_bbbbbbbbbbbbbbbbbbbbbbb', expiresAt: minutesFromNow(-60) });
    const expiredRes = await withDoor({ quotes: [expired] }, async (url) => {
      const res = await fetch(`${url}/mpp/quotes/${expired.id}/pay`, { method: 'POST' });
      return { status: res.status, type: res.headers.get('content-type'), body: (await res.json()) as { title: string } };
    });
    expect(expiredRes.result.status).toBe(403);
    expect(expiredRes.result.type).toContain('application/problem+json');
    expect(expiredRes.result.body.title).toBe('quote_expired');

    const quote = quoteFixture();
    const ucpOrder = orderFixture({ id: 'ord_ucp0000000000000000000', quoteId: QUOTE_ID, door: 'ucp', status: 'awaiting_approval' });
    const inUse = await withDoor({ quotes: [quote], liveOrders: [ucpOrder] }, async (url) => {
      const res = await fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      return { status: res.status, body: (await res.json()) as { title: string } };
    });
    expect(inUse.result.status).toBe(403);
    expect(inUse.result.body.title).toBe('quote_in_use');
  });

  it('200 with the order (no new payment) when the quote is already paid via MPP', async () => {
    const quote = quoteFixture();
    const paidOrder = orderFixture({ id: 'ord_mpp0000000000000000000a', quoteId: QUOTE_ID, door: 'mpp', status: 'paid' });
    const { result, paid } = await withDoor({ quotes: [quote], liveOrders: [paidOrder] }, async (url) => {
      const res = await fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      return { status: res.status, receipt: res.headers.get('payment-receipt'), body: (await res.json()) as PublicOrder };
    });
    expect(result.status).toBe(200);
    expect(result.receipt).toBeNull();
    expect(result.body.id).toBe(paidOrder.id);
    expect(paid).toEqual([]);
  });

  it('maps a service refusal to 403 problem+json with the service error code', async () => {
    const quote = quoteFixture();
    const { result } = await withDoor(
      { quotes: [quote], pay: [{ ok: false, error: 'payment_declined', message: 'card declined' }] },
      async (url) => {
        const client = mppxClient();
        const response = await client.fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
        return { status: response.status, type: response.headers.get('content-type'), body: (await response.json()) as { title: string; detail: string } };
      },
    );
    expect(result.status).toBe(403);
    expect(result.type).toContain('application/problem+json');
    expect(result.body.title).toBe('payment_declined');
    // Known-not-paid decline (service contract): the door may state it.
    expect(result.body.detail).toBe('card declined No payment was taken.');
  });

  it('a processing order is payment_pending (503 + Retry-After), never "not settled"', async () => {
    const quote = quoteFixture();
    const unsettled = orderFixture({ id: 'ord_mpp0000000000000000000b', quoteId: QUOTE_ID, door: 'mpp', status: 'authorizing' });
    const { result } = await withDoor({ quotes: [quote], pay: [{ ok: true, value: unsettled }] }, async (url) => {
      const client = mppxClient();
      const response = await client.fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      return {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        type: response.headers.get('content-type'),
        body: (await response.json()) as { title: string; detail: string },
      };
    });
    expect(result.status).toBe(503);
    expect(result.type).toContain('application/problem+json');
    expect(result.retryAfter).toMatch(/^\d+$/);
    expect(result.body.title).toBe('payment_pending');
    // The outcome is unknown: the response must not claim anything about charges.
    expect(result.body.detail).not.toMatch(/charg/i);
    expect(result.body.detail).toContain('SAME payment credential');
  });

  it('a known canceled(not_settled) order is 403 with accurate no-charge wording', async () => {
    const quote = quoteFixture();
    const canceled = orderFixture({
      id: 'ord_mpp0000000000000000000c',
      quoteId: QUOTE_ID,
      door: 'mpp',
      status: 'canceled',
      statusReason: 'not_settled',
    });
    const { result } = await withDoor({ quotes: [quote], pay: [{ ok: true, value: canceled }] }, async (url) => {
      const client = mppxClient();
      const response = await client.fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      return { status: response.status, body: (await response.json()) as { title: string; detail: string } };
    });
    expect(result.status).toBe(403);
    expect(result.body.title).toBe('not_settled');
    expect(result.body.detail).toContain('No payment was taken');
    expect(result.body.detail).toContain('ord_mpp0000000000000000000c');
  });

  it('releases the claim after an unexpected payWithSpt failure (500, then retryable)', async () => {
    const quote = quoteFixture();
    const { result, paid } = await withDoor(
      { quotes: [quote], pay: [new Error('connection reset'), paidResult()] },
      async (url) => {
        const client = mppxClient();
        const first = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
        const payment = await client.preparePayment(first, { request: { method: 'POST' } });
        const credential = await payment.createCredential();
        const init = payment.setCredential({ method: 'POST' }, credential);
        const failed = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, init);
        const retried = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, init);
        return {
          failedStatus: failed.status,
          retriedStatus: retried.status,
          retriedReceipt: retried.headers.get('payment-receipt'),
          body: (await retried.json()) as PublicOrder,
        };
      },
    );
    expect(result.failedStatus).toBe(500);
    // Same credential, same challenge — the claim was released, so it works.
    expect(result.retriedStatus).toBe(200);
    expect(result.retriedReceipt).toBeTruthy();
    expect(result.body.status).toBe('paid');
    expect(paid).toHaveLength(2);
  });

  it('payment_pending answers 503 and releases the claim: a same-credential retry pays once', async () => {
    const quote = quoteFixture();
    const pending: ServiceResult<Order> = {
      ok: false,
      error: 'payment_pending',
      message: 'Stripe has not confirmed the outcome of order ord_mpp0000000000000000000d.',
    };
    const { result, paid } = await withDoor({ quotes: [quote], pay: [pending, paidResult()] }, async (url) => {
      const client = mppxClient();
      const first = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      const payment = await client.preparePayment(first, { request: { method: 'POST' } });
      const credential = await payment.createCredential();
      const init = payment.setCredential({ method: 'POST' }, credential);
      const pendingRes = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, init);
      const problem = (await pendingRes.json()) as { title: string; detail: string };
      const retried = await client.rawFetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, init);
      return {
        pendingStatus: pendingRes.status,
        pendingRetryAfter: pendingRes.headers.get('retry-after'),
        problem,
        retriedStatus: retried.status,
        retriedReceipt: retried.headers.get('payment-receipt'),
        body: (await retried.json()) as PublicOrder,
      };
    });
    expect(result.pendingStatus).toBe(503);
    expect(result.pendingRetryAfter).toMatch(/^\d+$/);
    expect(result.problem.title).toBe('payment_pending');
    expect(result.problem.detail).not.toMatch(/charg/i);
    // Same credential, same challenge — the claim was released, so it resumes.
    expect(result.retriedStatus).toBe(200);
    expect(result.retriedReceipt).toBeTruthy();
    expect(result.body.status).toBe('paid');
    expect(paid.map((p) => p.spt)).toEqual([SPT, SPT]);
  });

  it('different_credential is answered verbatim: no claim about charges', async () => {
    const quote = quoteFixture();
    const { result } = await withDoor(
      { quotes: [quote], pay: [{ ok: false, error: 'different_credential', message: 'Order ord_x was already paid for with a different payment token.' }] },
      async (url) => {
        const client = mppxClient();
        const response = await client.fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
        return { status: response.status, body: (await response.json()) as { title: string; detail: string } };
      },
    );
    expect(result.status).toBe(403);
    expect(result.body.title).toBe('different_credential');
    expect(result.body.detail).toBe('Order ord_x was already paid for with a different payment token.');
  });

  it('a pending MPP order suppresses fresh challenges: 503, never an invitation to pay again', async () => {
    const authorizing = orderFixture({ id: 'ord_mpp0000000000000000000e', quoteId: QUOTE_ID, door: 'mpp', status: 'authorizing' });
    const plain = await withDoor({ quotes: [quoteFixture()], liveOrders: [authorizing] }, async (url) => {
      const res = await fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' });
      return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as { title: string } };
    });
    expect(plain.result.status).toBe(503);
    expect(plain.result.body.title).toBe('payment_pending');
    expect(plain.result.retryAfter).toMatch(/^\d+$/);

    // Same while the quote expired or was pruned: the live order resumes.
    const expired = quoteFixture({ expiresAt: minutesFromNow(-60) });
    const expiredRes = await withDoor({ quotes: [expired], liveOrders: [authorizing] }, async (url) =>
      fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' }).then(async (r) => ({ status: r.status, body: (await r.json()) as { title: string } })),
    );
    expect(expiredRes.result.status).toBe(503);
    expect(expiredRes.result.body.title).toBe('payment_pending');

    const pruned = await withDoor({ liveOrders: [authorizing] }, async (url) =>
      fetch(`${url}/mpp/quotes/${QUOTE_ID}/pay`, { method: 'POST' }).then((r) => r.status),
    );
    expect(pruned.result).toBe(503);
  });

  it('ambiguous create → 503 → same-credential retry → 200 paid with ONE PaymentIntent (real OrderService)', async () => {
    // Real OrderService + FakeGateway: the create "times out" after Stripe
    // processed it (the SDK-retries-exhausted crash window).
    const clock = { now: new Date(), advance(ms: number) { this.now = new Date(this.now.getTime() + ms); return this.now; } };
    const harness = await makeHarness({ config: { confirmation: 'instant', mppEnabled: true }, clock });
    const quote = await harness.quote();
    harness.gateway.failNext('authorizeSpt', 'ambiguous_after');
    const deps: DoorDeps = {
      service: harness.service,
      store: harness.store,
      getGraph: () => harness.graph.current,
      now: () => new Date(clock.now),
      config: harness.config,
    };
    const result = await withDeps(deps, async (url) => {
      const client = mppxClient();
      const first = await client.rawFetch(`${url}/mpp/quotes/${quote.id}/pay`, { method: 'POST' });
      const payment = await client.preparePayment(first, { request: { method: 'POST' } });
      const credential = await payment.createCredential();
      const init = payment.setCredential({ method: 'POST' }, credential);
      const pending = await client.rawFetch(`${url}/mpp/quotes/${quote.id}/pay`, init);
      const problem = (await pending.json()) as { title: string; detail: string };
      const retried = await client.rawFetch(`${url}/mpp/quotes/${quote.id}/pay`, init);
      return {
        pendingStatus: pending.status,
        pendingRetryAfter: pending.headers.get('retry-after'),
        problem,
        retriedStatus: retried.status,
        retriedReceipt: retried.headers.get('payment-receipt'),
        body: (await retried.json()) as PublicOrder,
      };
    });
    expect(result.pendingStatus).toBe(503);
    expect(result.pendingRetryAfter).toMatch(/^\d+$/);
    expect(result.problem.title).toBe('payment_pending');
    expect(result.problem.detail).not.toMatch(/charg/i);
    expect(result.retriedStatus).toBe(200);
    expect(result.retriedReceipt).toBeTruthy();
    expect(result.body.status).toBe('paid');
    // The retry resumed the SAME order: one order, one PaymentIntent, two
    // authorization calls (the second replayed the first's idempotency key).
    expect(harness.gateway.callsOf('authorizeSpt')).toHaveLength(2);
    expect(harness.gateway.intents.size).toBe(1);
    expect(await harness.service.listOrders()).toHaveLength(1);
  });

  it('mounts nothing when payments are not instant', () => {
    const { service } = makeService({});
    const deps = makeDeps(service);
    const door = createMppDoor({ ...deps, config: { ...deps.config, confirmation: 'owner_approves', mppEnabled: false } });
    expect(door.router).toBeUndefined();
  });
});
