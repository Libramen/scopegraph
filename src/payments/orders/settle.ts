/**
 * Settle — drives an order from an observed PaymentIntent through the
 * observation table (`observe.ts`): bind, hold → approval or capture, cancel,
 * refund, transition. Every path that reacts to Stripe (payment, owner
 * actions, webhooks, the sweep) ends up here, plus the two shared drivers on
 * top of it: `voidOrder` and `applySession` (link Checkout Sessions).
 *
 * Invariants that live here:
 * - Caller holds the order lock for the whole call.
 * - Each state change is `commit`ted (durable) BEFORE the Stripe call that
 *   follows it; Stripe call results are never trusted — the PI is re-observed
 *   and the table decides again. Each Stripe action runs at most once per call.
 * - A hold is re-checked against the frozen quote before it becomes
 *   `awaiting_approval` or is captured (`resolveHold`).
 * - MPP settles only inside its paying request (`live`); outside it, a hold or
 *   pending capture is voided (`not_settled`) once the order's last attempt
 *   is older than the processing grace — never captured.
 * - Releases (void/refund with a discrepancy) go through `releases.ts`.
 */
import type { Buyer, ObservedCheckoutSession, ObservedPaymentIntent, Order } from '../types.js';
import { computeApprovalDeadline, MIN_APPROVAL_LEAD_MS } from './deadline.js';
import { decide, isReleased, matchesQuote } from './observe.js';
import type { Step } from './observe.js';
import type { OrderCore } from './core.js';
import { errorText, PROCESSING_GRACE_MS } from './core.js';
import { releaseBackingOff, releaseResolved, trackRelease } from './releases.js';
import { cleanBuyer } from '../buyer.js';

const MAX_SETTLE_ROUNDS = 8;

export type SettleContext = {
  op: string;
  buyer?: Buyer;
  /** Inside the payWithSpt call that created/resumed the order (MPP may only settle here). */
  live?: boolean;
  /** The sweep's due release retry: release actions run even before `nextAttemptAt`. */
  releaseRetry?: boolean;
};

type SettleStep = Step | { kind: 'approval'; deadline: Date };

/**
 * A hold exists for an order that wanted one (SPT authorization or link
 * completion): re-check the quote, then owner approval (with deadline) or
 * instant capture; a failed re-check or a too-close deadline voids it.
 */
async function resolveHold(core: OrderCore, order: Order, pi: ObservedPaymentIntent): Promise<SettleStep> {
  if (!(await core.recheck(order))) {
    return { kind: 'cancel', paymentIntentId: pi.id, outcome: 'canceled', reason: 'requote_required' };
  }
  if (order.confirmation === 'instant') return { kind: 'capture', paymentIntentId: pi.id };
  const now = core.now();
  const deadline = computeApprovalDeadline({
    now,
    approvalWindowHours: core.config.approvalWindowHours,
    ...(order.request.date !== undefined ? { date: order.request.date } : {}),
    business: core.getGraph().business,
    ...(pi.captureBefore !== undefined ? { captureBefore: pi.captureBefore } : {}),
  });
  if (deadline.getTime() < now.getTime() + MIN_APPROVAL_LEAD_MS) {
    return { kind: 'cancel', paymentIntentId: pi.id, outcome: 'canceled', reason: 'date_too_soon' };
  }
  return { kind: 'approval', deadline };
}

/**
 * Drive an order from an observed PI until the table says stay or a
 * transition lands. Caller holds the order lock. Each Stripe action is
 * attempted at most once per call; the reconciler retries.
 */
export async function settle(core: OrderCore, start: Order, firstPi: ObservedPaymentIntent, ctx: SettleContext): Promise<Order> {
  let order = start;
  let pi = firstPi;
  const attempted = new Set<string>();
  // When the paying request last touched the order (before this call's own commits).
  const at = core.now().getTime();
  const lastAttemptAt = Math.max(
    Date.parse(start.createdAt),
    Date.parse(start.stripe.authorizeAttemptAt ?? start.createdAt),
    Date.parse(start.lastOperation?.at ?? start.createdAt),
  );
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
    if (isReleased(pi)) order = await releaseResolved(core, order, pi.id, ctx.op);
    // Bind the PI to an unbound order when it is provably ours.
    if (order.stripe.paymentIntentId === undefined && pi.metadata['orderId'] === order.id && matchesQuote(order, pi)) {
      const buyer = ctx.buyer;
      order = await core.commit(order, ctx.op, {}, (draft) => {
        draft.stripe.paymentIntentId = pi.id;
        if (buyer !== undefined) draft.buyer = { ...draft.buyer, ...buyer };
      });
    }
    let step: SettleStep = decide(order, pi);
    if (order.door === 'mpp' && ctx.live !== true && (step.kind === 'hold' || step.kind === 'capture')) {
      // MPP settles inside the paying request or not at all: the client was never told
      // "paid", so a hold found later (sweep, webhook) is voided, never captured — but only
      // after the same grace as the sweep, so a client retrying a pending answer can still
      // finish it (an early webhook leaves the order for that retry).
      step = at - lastAttemptAt < PROCESSING_GRACE_MS
        ? { kind: 'stay' }
        : { kind: 'cancel', paymentIntentId: pi.id, outcome: 'canceled', reason: 'not_settled' };
    }
    if (step.kind === 'hold') {
      if (order.status === 'awaiting_payment' && order.buyer === undefined && order.stripe.checkoutSessionId !== undefined) {
        // Link completion via a PI event: take the buyer from the session first.
        let session: ObservedCheckoutSession;
        try {
          session = await core.gateway.retrieveCheckoutSession(order.stripe.checkoutSessionId);
        } catch (err) {
          core.log(`could not retrieve session for ${order.id}: ${errorText(err)}`);
          return order;
        }
        // Same hygiene as applySession: buyer text typed on Stripe's page reaches owner terminals and hooks.
        const customer = cleanBuyer(session.customer);
        if (customer !== undefined) {
          order = await core.commit(order, ctx.op, {}, (draft) => {
            draft.buyer = { ...draft.buyer, ...customer };
          });
        }
      }
      step = await resolveHold(core, order, pi);
    }
    if (step.kind === 'recheck_paid') {
      step = (await core.recheck(order))
        ? { kind: 'transition', status: 'paid' }
        : { kind: 'refund', paymentIntentId: pi.id, discrepancy: `captured PaymentIntent ${pi.id} on link order ${order.id} failed the re-check` };
      if (step.kind === 'refund') order = await core.commit(order, ctx.op, { status: 'canceled', reason: 'requote_required' });
    }

    switch (step.kind) {
      case 'stay':
      case 'hold':
        return order;
      case 'discrepancy':
        return core.flagDiscrepancy(order, step.detail, ctx.op);
      case 'approval': {
        const deadline = step.deadline.toISOString();
        return core.commit(order, ctx.op, { status: 'awaiting_approval' }, (draft) => {
          draft.approvalDeadline = deadline;
        });
      }
      case 'transition': {
        if (step.discrepancy !== undefined) core.log(`DISCREPANCY order ${order.id}: ${step.discrepancy}`);
        const refundedCents = step.refundedCents;
        return core.commit(order, ctx.op, { status: step.status, ...(step.reason !== undefined ? { reason: step.reason } : {}) }, (draft) => {
          if (refundedCents !== undefined) draft.refundedCents = refundedCents;
        });
      }
      case 'capture': {
        if (attempted.has(`capture:${step.paymentIntentId}`)) return order;
        attempted.add(`capture:${step.paymentIntentId}`);
        if (order.status !== 'capturing') order = await core.commit(order, ctx.op, { status: 'capturing' });
        try {
          await core.gateway.capture(order, step.paymentIntentId);
        } catch (err) {
          core.log(`capture of ${step.paymentIntentId} for ${order.id} failed (re-observing): ${errorText(err)}`);
        }
        break;
      }
      case 'cancel': {
        if (attempted.has(`cancel:${step.paymentIntentId}`)) return order;
        attempted.add(`cancel:${step.paymentIntentId}`);
        if (step.discrepancy !== undefined) {
          if (releaseBackingOff(core, order, step.paymentIntentId, ctx.releaseRetry === true)) return order;
          order = await trackRelease(core, order, step.paymentIntentId, step.discrepancy, ctx.op);
        }
        if (step.outcome !== undefined) {
          order = await core.commit(order, ctx.op, {
            status: 'voiding',
            voidOutcome: step.outcome,
            ...(step.reason !== undefined ? { reason: step.reason } : {}),
            expireQuote: step.reason === 'requote_required',
          });
        } else if (step.reason !== undefined && order.statusReason !== step.reason) {
          order = await core.commit(order, ctx.op, { reason: step.reason });
        }
        try {
          await core.gateway.cancel(order, step.paymentIntentId);
        } catch (err) {
          core.log(`cancel of ${step.paymentIntentId} for ${order.id} failed (re-observing): ${errorText(err)}`);
        }
        break;
      }
      case 'refund': {
        if (attempted.has(`refund:${step.paymentIntentId}`)) return order;
        attempted.add(`refund:${step.paymentIntentId}`);
        if (releaseBackingOff(core, order, step.paymentIntentId, ctx.releaseRetry === true)) return order;
        order = await trackRelease(core, order, step.paymentIntentId, step.discrepancy, ctx.op, step.status);
        try {
          await core.gateway.refund(order, step.paymentIntentId);
        } catch (err) {
          core.log(`refund of ${step.paymentIntentId} for ${order.id} failed (re-observing): ${errorText(err)}`);
        }
        break;
      }
    }
    const observed = await core.observe(pi.id);
    if (observed === undefined) return order;
    pi = observed;
  }
  return order;
}

/** Enter `voiding` with an outcome and release the hold (caller holds the order lock). */
export async function voidOrder(
  core: OrderCore,
  order: Order,
  op: string,
  outcome: 'rejected' | 'expired' | 'canceled',
  reason: string | undefined,
): Promise<Order> {
  const voiding = await core.commit(order, op, { status: 'voiding', voidOutcome: outcome, ...(reason !== undefined ? { reason } : {}) });
  const piId = voiding.stripe.paymentIntentId;
  if (piId === undefined) return core.commit(voiding, op, { status: outcome });
  try {
    await core.gateway.cancel(voiding, piId);
  } catch (err) {
    core.log(`cancel of ${piId} for ${order.id} failed (re-observing): ${errorText(err)}`);
  }
  const pi = await core.observe(piId);
  return pi === undefined ? voiding : settle(core, voiding, pi, { op });
}

/** Apply a retrieved Checkout Session to a link order (caller holds the order lock). */
export async function applySession(core: OrderCore, order: Order, session: ObservedCheckoutSession, op: string): Promise<Order> {
  if (session.metadata['orderId'] !== order.id) {
    return core.flagDiscrepancy(order, `Checkout Session ${session.id} metadata.orderId is ${session.metadata['orderId'] ?? 'missing'}`, op);
  }
  if (session.status === 'complete' && session.paymentIntentId !== undefined) {
    const pi = await core.observe(session.paymentIntentId);
    if (pi === undefined) return order;
    // Buyer text typed on Stripe's page reaches owner terminals and hooks: same hygiene as UCP/ACP.
    const buyer = cleanBuyer(session.customer);
    return settle(core, order, pi, { op, ...(buyer !== undefined ? { buyer } : {}) });
  }
  if (session.status === 'expired' && order.status === 'awaiting_payment'
    && (order.stripe.checkoutSessionId === undefined || order.stripe.checkoutSessionId === session.id)) {
    return core.commit(order, op, { status: 'expired', reason: 'checkout_expired' });
  }
  return order;
}
