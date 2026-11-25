/**
 * Test doubles for the door modules: a scriptable in-memory `OrderService` plus shared
 * fixtures. The store itself is the real one (`PaymentsStore.memory()`), so checkout records,
 * idempotency keys and the webhook outbox behave exactly as in production.
 */
import { IS_TERMINAL } from './types.js';
import type { Buyer, Door, DoorDeps, Order, OrderService, OrderStatus, PaymentsConfig, PublicOrder, ScopedRequest, ServiceResult, StoredQuote } from './types.js';
import type { Graph } from '../graph/types.js';
import type { Quote } from '../engine/types.js';
import type { CheckoutResult, CheckoutView } from './checkout/index.js';
import { PaymentsStore } from './store/index.js';
import { graph, offering } from '../engine/testing.js';

// ─── OrderService double ─────────────────────────────────────────────────────

export interface FakeOrderService extends OrderService {
  quotes: Map<string, StoredQuote>;
  orders: Map<string, Order>;
  /** Set per test; default creates an owner_approves order on hold. */
  onPay: (input: { quoteId: string; door: Door; spt: string; buyer?: Buyer; checkoutId?: string }) => ServiceResult<Order>;
  onCancel: (orderId: string) => ServiceResult<Order>;
  payCalls: Array<{ quoteId: string; spt: string; checkoutId?: string; buyer?: Buyer }>;
  cancelCalls: string[];
}

let idCounter = 0;

function fakeOrderService(now: () => Date): FakeOrderService {
  const quotes = new Map<string, StoredQuote>();
  const orders = new Map<string, Order>();
  const payCalls: FakeOrderService['payCalls'] = [];
  const cancelCalls: string[] = [];

  const makeOrder = (quote: StoredQuote, door: Door, checkoutId: string | undefined, status: OrderStatus): Order => ({
    id: `ord_test${String(++idCounter).padStart(3, '0')}`,
    quoteId: quote.id,
    offering: quote.offering,
    request: quote.request,
    quote: quote.quote,
    confirmation: 'owner_approves',
    door,
    ...(checkoutId ? { checkoutId } : {}),
    createdAt: now().toISOString(),
    approvalDeadline: new Date(now().getTime() + 24 * 3_600_000).toISOString(),
    stripe: {},
    status,
    pendingHooks: [],
    version: 0,
  });

  const service: FakeOrderService = {
    quotes,
    orders,
    payCalls,
    cancelCalls,
    onPay: ({ quoteId, door, checkoutId }) => {
      const quote = quotes.get(quoteId);
      if (!quote) return { ok: false, error: 'quote_not_found', message: 'unknown quote' };
      const order = makeOrder(quote, door, checkoutId, 'awaiting_approval');
      orders.set(order.id, order);
      return { ok: true, value: structuredClone(order) };
    },
    onCancel: (orderId) => {
      const order = orders.get(orderId);
      if (!order) return { ok: false, error: 'order_not_found', message: 'unknown order' };
      if (order.status !== 'awaiting_approval') return { ok: false, error: 'invalid_state', message: `cannot cancel ${order.status}` };
      order.status = 'canceled';
      order.voidOutcome = 'canceled';
      order.version += 1;
      return { ok: true, value: structuredClone(order) };
    },
    async createQuote() {
      return undefined;
    },
    async getQuote(quoteId) {
      const quote = quotes.get(quoteId);
      return quote === undefined ? undefined : structuredClone(quote);
    },
    async startLinkOrder() {
      return { ok: false, error: 'door_unavailable', message: 'link door not under test' };
    },
    async payWithSpt(input) {
      payCalls.push({ quoteId: input.quoteId, spt: input.spt, checkoutId: input.checkoutId, buyer: input.buyer });
      return service.onPay(input);
    },
    async approve(orderId) {
      const order = orders.get(orderId);
      if (!order) return { ok: false, error: 'order_not_found', message: 'unknown order' };
      order.status = 'paid';
      order.version += 1;
      return { ok: true, value: structuredClone(order) };
    },
    async reject(orderId) {
      const order = orders.get(orderId);
      if (!order) return { ok: false, error: 'order_not_found', message: 'unknown order' };
      order.status = 'rejected';
      order.version += 1;
      return { ok: true, value: structuredClone(order) };
    },
    async cancel(orderId) {
      cancelCalls.push(orderId);
      return service.onCancel(orderId);
    },
    async getOrder(orderId) {
      const order = orders.get(orderId);
      return order === undefined ? undefined : structuredClone(order);
    },
    async getLiveOrderForQuote(quoteId) {
      let found: Order | undefined;
      for (const order of orders.values()) {
        if (order.quoteId !== quoteId) continue;
        if (!IS_TERMINAL[order.status] || order.status === 'paid') found = order;
      }
      return found === undefined ? undefined : structuredClone(found);
    },
    async listOrders(filter) {
      const all = Array.from(orders.values(), (order) => structuredClone(order));
      return filter?.status ? all.filter((order) => order.status === filter.status) : all;
    },
    toPublic(order): PublicOrder {
      return {
        id: order.id,
        offering: order.offering,
        status: order.status,
        confirmation: order.confirmation,
        door: order.door,
        quote: order.quote,
        approvalDeadline: order.approvalDeadline,
        statusUrl: `https://pay.example/orders/${order.id}`,
      };
    },
    async handleStripeTrigger() {},
    async reconcile() {},
  };
  return service;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function quoteFixture(): Quote {
  return {
    currency: 'usd',
    lines: [
      {
        id: 'surf-lesson.base',
        label: 'Surf Lesson',
        kind: 'base',
        amountCents: 7300,
        quantity: 1,
        unitAmountCents: 7300,
        taxable: true,
        source: { offering: 'surf-lesson' },
      },
    ],
    subtotalCents: 7300,
    taxCents: 0,
    totalCents: 7300,
  };
}

export function storedQuote(id: string, now: Date, quote: Quote = quoteFixture()): StoredQuote {
  const request: ScopedRequest = { answers: { participants: 2 }, selections: {} };
  return {
    id,
    offering: 'surf-lesson',
    request,
    quote,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  };
}

/** A well-formed quote id (`qt_` + 24 base32 chars) from a readable lowercase-letters label. */
export function testQuoteId(label: string): string {
  if (!/^[a-z]{1,24}$/.test(label)) throw new Error(`testQuoteId label must be 1-24 lowercase letters: ${label}`);
  return `qt_${label.padEnd(24, 'a')}`;
}

/** The stored checkout's view; throws on a refusal or an unknown id. */
export function checkoutView(result: CheckoutResult | undefined): CheckoutView {
  if (!result?.ok) throw new Error(`expected a stored checkout, got ${JSON.stringify(result)}`);
  return result.view;
}

export function paymentsConfig(overrides: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return {
    confirmation: 'owner_approves',
    approvalWindowHours: 24,
    quoteTtlMinutes: 30,
    publicUrl: 'https://pay.example',
    stripe: { secretKey: 'sk_test_redacted', webhookSecret: 'whsec_redacted', livemode: false, profileId: 'profile_test' },
    adminToken: 'a'.repeat(40),
    signingSecret: 's'.repeat(40),
    dataDir: './data-test',
    mppEnabled: false,
    acp: { bearerTokens: ['acp-token-redacted'], webhookUrl: 'https://agent.example/hooks', webhookSecret: 'whsec_acp_redacted' },
    ...overrides,
  };
}

const TEST_GRAPH = graph(
  [offering('surf-lesson', { name: 'Surf Lesson' })],
  { website: 'https://bluesurf.example', handoff: { url: 'https://bluesurf.example/handoff' } },
);

/** DoorDeps over the doubles and the real in-memory store. */
export interface TestDoorDeps extends DoorDeps {
  service: FakeOrderService;
}

export async function doorDeps(overrides: { now?: () => Date; config?: PaymentsConfig; graph?: Graph } = {}): Promise<TestDoorDeps> {
  const now = overrides.now ?? (() => new Date('2026-11-20T12:00:00Z'));
  return {
    service: fakeOrderService(now),
    config: overrides.config ?? paymentsConfig(),
    getGraph: () => overrides.graph ?? TEST_GRAPH,
    now,
    store: await PaymentsStore.memory(),
  };
}
