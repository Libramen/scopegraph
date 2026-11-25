/**
 * OrderCore — the shared primitives every order module builds on: the deps,
 * per-quote / per-order locks, the one durable transition (`commit`), the PI
 * observation read, the discrepancy flag and the quote re-check.
 *
 * Invariants that live here:
 * - Lock order is checkout (door) → quote → order; `withQuoteLock` is only
 *   ever taken outside an order lock.
 * - `commit` is the only way an order's status changes: CAS on `version` +
 *   durable write, awaited before the caller makes any Stripe call that
 *   follows it. Hooks are derived from the status change and recorded in the
 *   same write; an owner-closed order consumes its quote in that write too.
 * - `observe` never throws: `undefined` means "Stripe can't tell us right now",
 *   and the caller leaves the order for the reconciler.
 */
import { createHash } from 'node:crypto';
import type { Graph, Value } from '../../graph/types.js';
import { evaluate, factsContext } from '../../engine/index.js';
import type { FactsContext } from '../../extend/facts.js';
import type {
  HookName,
  ObservedPaymentIntent,
  Order,
  OrderStatus,
  PaymentGateway,
  PaymentsConfig,
  PublicOrder,
  ServiceError,
  ServiceResult,
} from '../types.js';
import { IS_TERMINAL } from '../types.js';
import type { PaymentsStore } from '../store/index.js';
import { redactStripeSecrets } from '../stripe/scrub.js';
import { HookRunner } from './hooks.js';
import type { OrderHooks } from './hooks.js';

/** Processing states (and out-of-request MPP holds) are left alone for this long. */
export const PROCESSING_GRACE_MS = 2 * 60_000;
const REASON_MAX = 500;

export type CommitPatch = { status?: OrderStatus; reason?: string; voidOutcome?: Order['voidOutcome']; expireQuote?: boolean };

export function fail<T>(error: ServiceError, message: string): ServiceResult<T> {
  return { ok: false, error, message };
}

/** Non-terminal, or paid: the order that owns its quote (one per quote). */
export function isLive(order: Order): boolean {
  return !IS_TERMINAL[order.status] || order.status === 'paid';
}

/** SHA-256 of the raw SPT, base64url — the raw token is never persisted. */
export function sptFingerprint(spt: string): string {
  return createHash('sha256').update(spt).digest('base64url');
}

/** Scrubbed, trimmed, ≤ 500 chars; undefined when empty. Safe to show buyers and agents. */
export function publicReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const scrubbed = redactStripeSecrets(reason.trim()) ?? '';
  if (scrubbed === '') return undefined;
  return scrubbed.length > REASON_MAX ? scrubbed.slice(0, REASON_MAX) : scrubbed;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What agents and public pages may see: no buyer PII, no answers. */
export function toPublicOrder(order: Order, publicUrl: string): PublicOrder {
  return {
    id: order.id,
    offering: order.offering,
    status: order.status,
    ...(order.statusReason !== undefined ? { statusReason: order.statusReason } : {}),
    confirmation: order.confirmation,
    door: order.door,
    quote: structuredClone(order.quote),
    ...(order.approvalDeadline !== undefined ? { approvalDeadline: order.approvalDeadline } : {}),
    ...(order.door === 'link' && order.status === 'awaiting_payment' && order.stripe.checkoutUrl !== undefined
      ? { paymentUrl: order.stripe.checkoutUrl }
      : {}),
    statusUrl: `${publicUrl}/orders/${order.id}`,
  };
}

export interface OrderCoreDeps {
  store: PaymentsStore;
  gateway: PaymentGateway;
  config: PaymentsConfig;
  getGraph: () => Graph;
  now: () => Date;
  getFacts: (ctx: FactsContext) => Promise<Record<string, Value>>;
  /** Already prefixed and scrubbed. */
  log: (line: string) => void;
  hooks: OrderHooks;
  hookTimeoutMs: number;
}

export class OrderCore {
  readonly store: PaymentsStore;
  readonly gateway: PaymentGateway;
  readonly config: PaymentsConfig;
  readonly getGraph: () => Graph;
  readonly now: () => Date;
  readonly getFacts: (ctx: FactsContext) => Promise<Record<string, Value>>;
  readonly log: (line: string) => void;
  readonly hooks: HookRunner;
  /** Throttle for the "quote store full" log line. */
  quotesFullLoggedAt = Number.NEGATIVE_INFINITY;
  /** Throttle for the "client holds too many unpaid quotes/orders" log line. */
  clientQuotaLoggedAt = Number.NEGATIVE_INFINITY;
  /** Throttle for the "too many open unpaid orders" log line. */
  unpaidOrdersLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: OrderCoreDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.config = deps.config;
    this.getGraph = deps.getGraph;
    this.now = deps.now;
    this.getFacts = deps.getFacts;
    this.log = deps.log;
    this.hooks = new HookRunner(this, deps.hooks, deps.hookTimeoutMs);
  }

  withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
    return this.store.locks.withLock(`order:${orderId}`, fn);
  }

  withQuoteLock<T>(quoteId: string, fn: () => Promise<T>): Promise<T> {
    return this.store.locks.withLock(`quote:${quoteId}`, fn);
  }

  /**
   * CAS + durable write of one transition. Hooks are derived from the status
   * change and recorded in the same write. Caller holds the order lock.
   */
  async commit(order: Order, op: string, patch: CommitPatch, mutate?: (draft: Order) => void): Promise<Order> {
    const now = this.now().toISOString();
    const result = await this.store.updateOrder(order.id, order.version, (draft, data) => {
      const before = draft.status;
      mutate?.(draft);
      if (patch.status !== undefined) draft.status = patch.status;
      if (patch.voidOutcome !== undefined) draft.voidOutcome = patch.voidOutcome;
      if (patch.reason !== undefined) draft.statusReason = patch.reason;
      const after = draft.status;
      // The owner said no (or let the approval lapse): the same request must not be
      // re-submitted to them — the quote is consumed and the buyer has to re-scope.
      // payment_failed / canceled before money moved keep the quote usable.
      const ownerClosed = (after === 'rejected' || after === 'expired') && (before === 'awaiting_approval' || before === 'voiding');
      if (patch.expireQuote === true || ownerClosed) {
        const quote = data.quotes[draft.quoteId];
        if (quote !== undefined && Date.parse(quote.expiresAt) > Date.parse(now)) quote.expiresAt = now;
      }
      const hooks: HookName[] = [];
      if (after !== before) {
        if (after === 'awaiting_approval') hooks.push('onApprovalNeeded');
        if (after === 'paid') hooks.push('onPaid');
        if (IS_TERMINAL[after] && after !== 'paid' && (!IS_TERMINAL[before] || before === 'paid')) hooks.push('onClosed');
      }
      for (const hook of hooks) draft.pendingHooks.push({ hook, attempts: 0 });
      draft.lastOperation = { op, result: after, at: now };
    });
    if (!result.ok) throw new Error(`order ${order.id} ${result.reason === 'conflict' ? 'changed concurrently' : 'disappeared'} during ${op}`);
    return result.value;
  }

  /** Retrieve a PI; `undefined` when Stripe can't tell us right now. */
  async observe(paymentIntentId: string): Promise<ObservedPaymentIntent | undefined> {
    try {
      return await this.gateway.retrievePaymentIntent(paymentIntentId);
    } catch (err) {
      this.log(`could not retrieve ${paymentIntentId}: ${errorText(err)}`);
      return undefined;
    }
  }

  async flagDiscrepancy(order: Order, detail: string, op: string): Promise<Order> {
    this.log(`DISCREPANCY order ${order.id}: ${detail}`);
    return order.statusReason === 'discrepancy' ? order : this.commit(order, op, { reason: 'discrepancy' });
  }

  /** Re-evaluate the frozen request with fresh server facts and `now`: still qualified at the same price? */
  async recheck(order: Pick<Order, 'offering' | 'request' | 'quote'>): Promise<boolean> {
    const graph = this.getGraph();
    const now = this.now();
    const context = factsContext(graph, order.offering, order.request.date, now);
    let facts: Record<string, Value> = {};
    if (context !== undefined) {
      try {
        facts = await this.getFacts(context);
      } catch (err) {
        this.log(`getFacts failed during re-check of ${order.offering}: ${errorText(err)}`);
      }
    }
    const result = evaluate(
      graph,
      {
        offering: order.offering,
        answers: order.request.answers,
        selections: order.request.selections,
        ...(order.request.date !== undefined ? { date: order.request.date } : {}),
        facts,
      },
      { now, trace: false },
    );
    return result.status === 'qualified'
      && result.quote.totalCents === order.quote.totalCents
      && result.quote.currency.toUpperCase() === order.quote.currency.toUpperCase();
  }
}
