/**
 * SPT doors (UCP, ACP, MPP) — `payWithSpt`: start or resume the quote's order,
 * authorize the shared payment token, settle the observed PaymentIntent, and
 * for `requireSettled` (MPP) answer only what is known.
 *
 * Invariants that live here:
 * - The `authorizing` order (token fingerprint, attempt time) is durable
 *   BEFORE the PaymentIntent create; the raw SPT is never persisted.
 * - Same SPT ⇒ same idempotency key (`scopegraph:<id>:authorize:<fingerprint>`):
 *   a retry resumes the live order and can never create a second charge; a
 *   different SPT on an order with a credential is refused.
 * - Lock order: quote lock (start/resume) is released before the order lock
 *   (authorize + settle) is taken. Hooks are kicked after the lock is released.
 * - `requireSettled`: ok only when paid; `payment_declined` only when the order
 *   is closed unpaid with nothing left to release; anything else is
 *   `payment_pending` — never "not charged" while the outcome is unknown.
 */
import type { Buyer, Door, ObservedPaymentIntent, Order, ServiceResult } from '../types.js';
import { DefinitiveGatewayError, IS_TERMINAL } from '../types.js';
import { isUnpaidTerminal } from './observe.js';
import type { OrderCore } from './core.js';
import { sptFingerprint, errorText, fail, isLive, publicReason } from './core.js';
import { admitOrder, funnel, newOrder } from './funnel.js';
import { settle, voidOrder } from './settle.js';

export interface PayWithSptInput {
  quoteId: string;
  door: Exclude<Door, 'link'>;
  spt: string;
  buyer?: Buyer;
  checkoutId?: string;
  requireSettled?: boolean;
}

export async function payWithSpt(core: OrderCore, input: PayWithSptInput): Promise<ServiceResult<Order>> {
  if (typeof input.spt !== 'string' || input.spt === '') return fail('payment_declined', 'A shared payment token is required.');
  const fingerprint = sptFingerprint(input.spt);
  const mustBeInstant = input.door === 'mpp' || input.requireSettled === true;

  const started = await core.withQuoteLock(input.quoteId, async (): Promise<ServiceResult<Order>> => {
    // The live order first: a same-credential retry resumes it even after the stored quote is gone.
    const live = core.store.ordersForQuote(input.quoteId).find(isLive);
    if (live !== undefined) {
      if (live.door !== input.door || (input.checkoutId !== undefined && live.checkoutId !== input.checkoutId)) {
        return fail('quote_in_use', `Quote ${input.quoteId} is already being paid elsewhere (order ${live.id}).`);
      }
      if (live.stripe.tokenFingerprint !== undefined && live.stripe.tokenFingerprint !== fingerprint) {
        return fail('different_credential', `Order ${live.id} was already paid for with a different payment token.`);
      }
      if (mustBeInstant && live.confirmation !== 'instant') return fail('door_unavailable', 'This order requires owner approval; it cannot settle immediately.');
      return { ok: true, value: live };
    }
    const quote = core.store.getQuote(input.quoteId);
    if (quote === undefined) return fail('quote_not_found', `Quote ${input.quoteId} not found. Scope the request first.`);
    if (mustBeInstant && core.config.confirmation !== 'instant') {
      return fail('door_unavailable', 'Immediate settlement is unavailable: this business approves each order before charging.');
    }
    if (core.config.confirmation === 'owner_approves' && (input.door === 'ucp' || input.door === 'acp')
      && (input.buyer?.email === undefined || input.buyer.email.trim() === '')) {
      return fail('buyer_email_required', 'The business confirms each order by email: provide the buyer email address.');
    }
    const checked = await funnel(core, quote, input.door);
    if (!checked.ok) return checked;
    const order = newOrder(core, quote, input.door, 'authorizing', {
      ...(input.checkoutId !== undefined ? { checkoutId: input.checkoutId } : {}),
      ...(input.buyer !== undefined ? { buyer: { ...input.buyer } } : {}),
      stripe: { tokenFingerprint: fingerprint, authorizeAttemptAt: core.now().toISOString() },
      lastOperation: { op: 'authorize', result: 'authorizing', at: core.now().toISOString() },
    });
    return admitOrder(core, order);
  });
  if (!started.ok) return started;

  const orderId = started.value.id;
  const order = await core.withOrderLock(orderId, () => authorize(core, orderId, input.spt, fingerprint));
  core.hooks.kick(orderId);
  if (input.requireSettled !== true) return { ok: true, value: order };

  const settled = await core.withOrderLock(orderId, () => settleRequired(core, orderId));
  core.hooks.kick(orderId);
  return settled;
}

/**
 * `requireSettled`: ok only when paid; `payment_declined` only when the order
 * is closed unpaid with nothing left to release; anything else is
 * `payment_pending` (the caller retries with the same credential, which
 * resumes this order under the same idempotency key). A hold that did not
 * settle is voided so the order closes `canceled (not_settled)` — a PI that
 * surfaces later then hits the terminal-unpaid row and is released, never
 * captured. Order lock held.
 */
async function settleRequired(core: OrderCore, orderId: string): Promise<ServiceResult<Order>> {
  let order = core.store.getOrder(orderId);
  if (order === undefined) throw new Error(`order ${orderId} disappeared`);
  const piId = order.stripe.paymentIntentId;
  if (!IS_TERMINAL[order.status] && piId !== undefined) {
    const pi = await core.observe(piId);
    if (pi !== undefined) {
      order = pi.status === 'requires_capture' && order.status !== 'voiding'
        ? await voidOrder(core, order, 'settle_required', 'canceled', 'not_settled')
        : await settle(core, order, pi, { op: 'settle_required', live: true });
    }
  }
  if (order.status === 'paid') return { ok: true, value: order };
  if ((isUnpaidTerminal(order.status) || order.status === 'refunded') && (order.releases?.length ?? 0) === 0) {
    return fail('payment_declined', `Payment did not settle (order ${order.id} is ${order.status}${order.statusReason !== undefined ? `: ${order.statusReason}` : ''}).`);
  }
  return fail(
    'payment_pending',
    `The payment outcome for order ${order.id} is not known yet (${order.status}). Retry with the same payment credential: `
      + 'it resumes this order and is never charged twice.',
  );
}

/** Issue (or re-issue with the same idempotency key) the SPT authorization. Order lock held. */
async function authorize(core: OrderCore, orderId: string, spt: string, fingerprint: string): Promise<Order> {
  const order = core.store.getOrder(orderId);
  if (order === undefined) throw new Error(`order ${orderId} disappeared`);
  if (order.status !== 'authorizing') return order;
  if (order.stripe.paymentIntentId !== undefined) {
    const pi = await core.observe(order.stripe.paymentIntentId);
    return pi === undefined ? order : settle(core, order, pi, { op: 'authorize', live: true });
  }
  let pi: ObservedPaymentIntent;
  try {
    pi = await core.gateway.authorizeSpt({
      order,
      spt,
      fingerprint,
      ...(order.buyer?.email !== undefined ? { receiptEmail: order.buyer.email } : {}),
    });
  } catch (err) {
    if (err instanceof DefinitiveGatewayError) {
      core.log(`authorization for ${order.id} declined: ${err.message}`);
      return core.commit(order, 'authorize', { status: 'payment_failed', reason: publicReason(err.code ?? 'payment_declined') ?? 'payment_declined' });
    }
    core.log(`authorization for ${order.id} ambiguous (stays authorizing): ${errorText(err)}`);
    return order;
  }
  return settle(core, order, pi, { op: 'authorize', live: true });
}
