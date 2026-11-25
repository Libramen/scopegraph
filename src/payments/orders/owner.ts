/**
 * Owner and buyer actions — `approve`, `reject` (owner, via signed links, the
 * admin API or the CLI) and `cancel` (buyer/agent via UCP/ACP).
 *
 * Invariants that live here:
 * - Each action runs under the order lock and is idempotent: repeating the
 *   outcome already reached (or in flight) answers ok without a Stripe call.
 * - Approve past the approval deadline never captures — it voids (`expired`).
 * - `capturing` / `voiding` are committed BEFORE the capture / cancel call; the
 *   PI is then re-observed and `settle` (the observation table) decides.
 * - Hooks are kicked after the order lock is released.
 */
import type { ObservedCheckoutSession, Order, ServiceResult } from '../types.js';
import type { OrderCore } from './core.js';
import { errorText, fail, publicReason } from './core.js';
import { applySession, settle, voidOrder } from './settle.js';

export async function approve(core: OrderCore, orderId: string): Promise<ServiceResult<Order>> {
  const result = await core.withOrderLock(orderId, async (): Promise<ServiceResult<Order>> => {
    const order = core.store.getOrder(orderId);
    if (order === undefined) return fail('order_not_found', `Order ${orderId} not found.`);
    if (order.status !== 'awaiting_approval') {
      // Idempotent: the outcome approve asks for already happened (or is in flight).
      if (order.status === 'paid' || order.status === 'capturing') return { ok: true, value: order };
      return fail('invalid_state', `Order ${orderId} is ${order.status}; only orders awaiting approval can be approved.`);
    }
    const deadline = order.approvalDeadline === undefined ? Number.NaN : Date.parse(order.approvalDeadline);
    if (!(core.now().getTime() < deadline)) {
      // Past the deadline: never capture — release the hold.
      return { ok: true, value: await voidOrder(core, order, 'approve', 'expired', 'approval_deadline_passed') };
    }
    const piId = order.stripe.paymentIntentId;
    if (piId === undefined) return fail('invalid_state', `Order ${orderId} has no authorization to capture.`);
    const capturing = await core.commit(order, 'approve', { status: 'capturing' });
    try {
      await core.gateway.capture(capturing, piId);
    } catch (err) {
      core.log(`capture of ${piId} for ${orderId} failed (re-observing): ${errorText(err)}`);
    }
    const pi = await core.observe(piId);
    return { ok: true, value: pi === undefined ? capturing : await settle(core, capturing, pi, { op: 'approve' }) };
  });
  if (result.ok) core.hooks.kick(orderId);
  return result;
}

export async function reject(core: OrderCore, orderId: string, reason?: string): Promise<ServiceResult<Order>> {
  const result = await core.withOrderLock(orderId, async (): Promise<ServiceResult<Order>> => {
    const order = core.store.getOrder(orderId);
    if (order === undefined) return fail('order_not_found', `Order ${orderId} not found.`);
    if (order.status !== 'awaiting_approval') {
      if (order.status === 'rejected' || (order.status === 'voiding' && order.voidOutcome === 'rejected')) return { ok: true, value: order };
      return fail('invalid_state', `Order ${orderId} is ${order.status}; only orders awaiting approval can be rejected.`);
    }
    return { ok: true, value: await voidOrder(core, order, 'reject', 'rejected', publicReason(reason)) };
  });
  if (result.ok) core.hooks.kick(orderId);
  return result;
}

/** Buyer/agent cancel (UCP/ACP): voids a hold, expires an unpaid link session; refuses in-flight and paid orders. */
export async function cancel(core: OrderCore, orderId: string): Promise<ServiceResult<Order>> {
  const result = await core.withOrderLock(orderId, async (): Promise<ServiceResult<Order>> => {
    const order = core.store.getOrder(orderId);
    if (order === undefined) return fail('order_not_found', `Order ${orderId} not found.`);
    switch (order.status) {
      case 'awaiting_approval':
        return { ok: true, value: await voidOrder(core, order, 'cancel', 'canceled', 'canceled_by_buyer') };
      case 'awaiting_payment': {
        const sessionId = order.stripe.checkoutSessionId;
        if (sessionId === undefined) return { ok: true, value: await core.commit(order, 'cancel', { status: 'canceled', reason: 'canceled_by_buyer' }) };
        try {
          await core.gateway.expireCheckoutSession(sessionId);
        } catch (err) {
          core.log(`expire of ${sessionId} for ${orderId} failed (re-observing): ${errorText(err)}`);
        }
        let session: ObservedCheckoutSession;
        try {
          session = await core.gateway.retrieveCheckoutSession(sessionId);
        } catch {
          return fail('invalid_state', `Order ${orderId} could not be canceled right now; retry.`);
        }
        if (session.status === 'expired') return { ok: true, value: await core.commit(order, 'cancel', { status: 'canceled', reason: 'canceled_by_buyer' }) };
        const applied = await applySession(core, order, session, 'cancel');
        return fail('invalid_state', `Order ${orderId} was already paid on the payment page and is ${applied.status}.`);
      }
      case 'canceled':
        return { ok: true, value: order };
      case 'voiding':
        if (order.voidOutcome === 'canceled') return { ok: true, value: order };
        return fail('invalid_state', `Order ${orderId} is being released (${order.voidOutcome ?? 'voiding'}).`);
      default:
        return fail('invalid_state', `Order ${orderId} is ${order.status} and cannot be canceled${order.status === 'authorizing' || order.status === 'capturing' ? ' while payment is in progress; retry shortly' : ''}.`);
    }
  });
  if (result.ok) core.hooks.kick(orderId);
  return result;
}
