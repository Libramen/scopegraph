/**
 * Release bookkeeping — money an order must not keep (a stray second PI, a
 * hold or capture on a dead order, a capture after the owner rejected) is
 * voided or refunded, and every such release is tracked on the order
 * (`order.releases`) until Stripe shows it done.
 *
 * Invariants that live here:
 * - The release is tracked durably (`trackRelease`) BEFORE the Stripe
 *   cancel/refund call, and the order is flagged `discrepancy`.
 * - An entry is cleared only when an observation shows the PI released
 *   (`isReleased`), never on a call's own result.
 * - Only the sweep's due retries count toward `MAX_RELEASE_ATTEMPTS`
 *   (backoff 1 min doubling, ≤ 1 h); webhook-triggered attempts before
 *   `nextAttemptAt` are skipped. At the cap the entry is kept with a loud log.
 * - While an entry is unresolved and not given up, the webhook answers 500
 *   (`releasePending`) so Stripe redelivers. Such orders are never pruned.
 */
import type { Order, OrderStatus } from '../types.js';
import type { OrderCore } from './core.js';

/** Unresolved releases are retried with backoff (1 min doubling, ≤ 1 h), then given up loudly (entry kept). */
export const MAX_RELEASE_ATTEMPTS = 10;
const RELEASE_BACKOFF_BASE_MS = 60_000;
const RELEASE_BACKOFF_MAX_MS = 3_600_000;

/**
 * Flag + durably track a release (void/refund) of `paymentIntentId` before the
 * Stripe call, optionally committing the order to `status` in the same write.
 */
export async function trackRelease(
  core: OrderCore,
  order: Order,
  paymentIntentId: string,
  detail: string,
  op: string,
  status?: OrderStatus,
): Promise<Order> {
  core.log(`DISCREPANCY order ${order.id}: ${detail}`);
  const tracked = order.releases?.some((r) => r.paymentIntentId === paymentIntentId) === true;
  if (tracked && order.statusReason === 'discrepancy' && (status === undefined || order.status === status)) return order;
  const now = core.now().toISOString();
  return core.commit(order, op, { reason: 'discrepancy', ...(status !== undefined ? { status } : {}) }, (draft) => {
    if (!tracked) (draft.releases ??= []).push({ paymentIntentId, attempts: 0, nextAttemptAt: now });
  });
}

/** Stripe shows the PI released: stop tracking it. */
export async function releaseResolved(core: OrderCore, order: Order, paymentIntentId: string, op: string): Promise<Order> {
  if (order.releases?.some((r) => r.paymentIntentId === paymentIntentId) !== true) return order;
  return core.commit(order, op, {}, (draft) => {
    const rest = (draft.releases ?? []).filter((r) => r.paymentIntentId !== paymentIntentId);
    if (rest.length > 0) draft.releases = rest;
    else delete draft.releases;
  });
}

/** A sweep release attempt ended unresolved: back off, and give up loudly (keeping the entry) after the cap. */
export async function releaseAttemptFailed(core: OrderCore, order: Order, paymentIntentId: string, op: string): Promise<Order> {
  const entry = order.releases?.find((r) => r.paymentIntentId === paymentIntentId);
  if (entry === undefined) return order;
  const attempts = entry.attempts + 1;
  const delay = Math.min(RELEASE_BACKOFF_BASE_MS * 2 ** (attempts - 1), RELEASE_BACKOFF_MAX_MS);
  const next = new Date(core.now().getTime() + delay).toISOString();
  if (attempts >= MAX_RELEASE_ATTEMPTS) {
    core.log(`RELEASE GIVEN UP order ${order.id}: PaymentIntent ${paymentIntentId} still holds money the order must not keep after ${String(attempts)} attempts — void/refund it in the Stripe Dashboard`);
  } else {
    core.log(`release of ${paymentIntentId} for ${order.id} unresolved (attempt ${String(attempts)}); retrying after ${next}`);
  }
  return core.commit(order, op, {}, (draft) => {
    const target = draft.releases?.find((r) => r.paymentIntentId === paymentIntentId);
    if (target === undefined) return;
    target.attempts = attempts;
    target.nextAttemptAt = next;
  });
}

/**
 * A tracked release waiting out its backoff: only the sweep's due retry
 * (`releaseRetry`) acts on it, so redelivered webhooks can't burn through the
 * attempts during a Stripe outage.
 */
export function releaseBackingOff(core: OrderCore, order: Order, paymentIntentId: string, releaseRetry: boolean): boolean {
  if (releaseRetry) return false;
  const entry = order.releases?.find((r) => r.paymentIntentId === paymentIntentId);
  return entry !== undefined && core.now().getTime() < Date.parse(entry.nextAttemptAt);
}

/** True while a release of `paymentIntentId` is tracked and not given up (Stripe should retry the webhook). */
export function releasePending(core: OrderCore, orderId: string, paymentIntentId: string | undefined): boolean {
  if (paymentIntentId === undefined) return false;
  return core.store.getOrder(orderId)?.releases?.some((r) => r.paymentIntentId === paymentIntentId && r.attempts < MAX_RELEASE_ATTEMPTS) === true;
}
