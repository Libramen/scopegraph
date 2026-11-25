/**
 * OrderService — the only code that changes order state. This file is the
 * facade: it wires the deps into an `OrderCore` and a `HookRunner` and
 * delegates each `OrderService` operation to the module that owns it.
 *
 *   core.ts       shared primitives: locks, `commit` (CAS + durable), observe, re-check
 *   funnel.ts     quotes, the funnel, link door (startLinkOrder + Checkout Session)
 *   authorize.ts  SPT doors: payWithSpt, authorization, requireSettled (MPP)
 *   settle.ts     the observation-table driver: settle, voidOrder, applySession
 *   owner.ts      approve / reject (owner), cancel (buyer)
 *   reconcile.ts  webhook triggers + the reconciler sweep
 *   releases.ts   tracking voids/refunds of money an order must not keep
 *   hooks.ts      at-least-once, time-boxed delivery of order hooks
 *
 * Every transition: per-order lock + CAS on `version` + durable write, BEFORE
 * any Stripe call that follows it. Stripe results are never trusted: after
 * every authorize/capture/cancel/refund the PaymentIntent is (re-)observed and
 * the observation table (`observe.ts`) decides. Ambiguous Stripe failures leave
 * the order in its processing state for the reconciler.
 *
 * Lock order: checkout (door) → quote → order. Hooks run after the order lock
 * is released (fire-and-forget, tracked, time-boxed; the reconciler retries
 * failures without waiting for them).
 */
import type { Graph, Value } from '../../graph/types.js';
import type { Quote } from '../../engine/types.js';
import { getFacts as defaultGetFacts } from '../../extend/facts.js';
import type { FactsContext } from '../../extend/facts.js';
import * as defaultHooks from '../../extend/orders.js';
import type {
  Order,
  OrderService,
  OrderStatus,
  PaymentGateway,
  PaymentsConfig,
  PublicOrder,
  ScopedRequest,
  ServiceResult,
  StoredQuote,
} from '../types.js';
import type { PaymentsStore } from '../store/index.js';
import { redactStripeSecrets } from '../stripe/scrub.js';
import { isLive, OrderCore, toPublicOrder } from './core.js';
import { HOOK_TIMEOUT_MS } from './hooks.js';
import type { OrderHooks } from './hooks.js';
import { createQuote, startLinkOrder } from './funnel.js';
import { payWithSpt } from './authorize.js';
import type { PayWithSptInput } from './authorize.js';
import { approve, cancel, reject } from './owner.js';
import { handleStripeTrigger, reconcile } from './reconcile.js';

export type { OrderHooks } from './hooks.js';

export interface OrderServiceDeps {
  store: PaymentsStore;
  gateway: PaymentGateway;
  config: PaymentsConfig;
  getGraph: () => Graph;
  now?: () => Date;
  hooks?: OrderHooks;
  getFacts?: (ctx: FactsContext) => Promise<Record<string, Value>>;
  /** One line per event; default stderr. Lines are scrubbed before this is called. */
  log?: (line: string) => void;
  /** A hook call still running after this long counts as a failed attempt (default 10s). */
  hookTimeoutMs?: number;
}

export class DefaultOrderService implements OrderService {
  private readonly core: OrderCore;

  constructor(deps: OrderServiceDeps) {
    const sink = deps.log ?? ((line: string) => console.error(line));
    this.core = new OrderCore({
      store: deps.store,
      gateway: deps.gateway,
      config: deps.config,
      getGraph: deps.getGraph,
      now: deps.now ?? (() => new Date()),
      getFacts: deps.getFacts ?? defaultGetFacts,
      log: (line) => sink(redactStripeSecrets(`scopegraph payments: ${line}`) ?? ''),
      hooks: deps.hooks ?? defaultHooks,
      hookTimeoutMs: deps.hookTimeoutMs ?? HOOK_TIMEOUT_MS,
    });
  }

  // ── Quotes and reads ───────────────────────────────────────────────────────

  createQuote(offering: string, request: ScopedRequest, quote: Quote, client?: string): Promise<StoredQuote | undefined> {
    return createQuote(this.core, offering, request, quote, client);
  }

  async getQuote(quoteId: string): Promise<StoredQuote | undefined> {
    return this.core.store.getQuote(quoteId);
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.core.store.getOrder(orderId);
  }

  async getLiveOrderForQuote(quoteId: string): Promise<Order | undefined> {
    return this.core.store.ordersForQuote(quoteId).find(isLive);
  }

  async listOrders(filter?: { status?: OrderStatus }): Promise<Order[]> {
    return this.core.store
      .listOrders()
      .filter((o) => filter?.status === undefined || o.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  toPublic(order: Order): PublicOrder {
    return toPublicOrder(order, this.core.config.publicUrl);
  }

  // ── Doors ──────────────────────────────────────────────────────────────────

  startLinkOrder(quoteId: string): Promise<ServiceResult<{ order: PublicOrder; url: string }>> {
    return startLinkOrder(this.core, quoteId);
  }

  payWithSpt(input: PayWithSptInput): Promise<ServiceResult<Order>> {
    return payWithSpt(this.core, input);
  }

  // ── Owner + buyer actions ──────────────────────────────────────────────────

  approve(orderId: string): Promise<ServiceResult<Order>> {
    return approve(this.core, orderId);
  }

  reject(orderId: string, reason?: string): Promise<ServiceResult<Order>> {
    return reject(this.core, orderId, reason);
  }

  cancel(orderId: string): Promise<ServiceResult<Order>> {
    return cancel(this.core, orderId);
  }

  // ── Stripe triggers, sweep, hooks ──────────────────────────────────────────

  handleStripeTrigger(event: { type: string; objectId: string; metadata: Record<string, string> }): Promise<void> {
    return handleStripeTrigger(this.core, event);
  }

  reconcile(now?: Date): Promise<void> {
    return reconcile(this.core, now);
  }

  /** Resolves when every in-flight hook run has finished (tests, shutdown). */
  drainHooks(): Promise<void> {
    return this.core.hooks.drain();
  }

  /** One pass over an order's pending hooks; each entry is tried once. */
  runHooks(orderId: string): Promise<void> {
    return this.core.hooks.run(orderId);
  }
}

export function createOrderService(deps: OrderServiceDeps): DefaultOrderService {
  return new DefaultOrderService(deps);
}
