/**
 * The observation table: what an observed PaymentIntent means for
 * an order in a given state. Pure and synchronous — the order service turns
 * the returned step into durable transitions and Stripe calls, re-observes,
 * and asks again until the table says `stay` (or a transition is final).
 *
 * | observed PI → / order | authorizing | awaiting_approval | capturing | voiding | awaiting_payment | terminal-unpaid |
 * |---|---|---|---|---|---|---|
 * | requires_capture | hold (re-check → approval / capture) | stay | capture | cancel | hold (link completion) | cancel |
 * | succeeded | paid | paid | paid | paid + discrepancy (outcome rejected: rejected + refund + discrepancy) | re-check → paid, else refund | refund + discrepancy |
 * | canceled / requires_payment_method | payment_failed | expired (hold lapsed) | payment_failed | voidOutcome | stay | stay |
 * | processing | stay | stay | stay | stay | stay | stay |
 * | requires_action | cancel → payment_failed | stay | stay | stay | stay | stay |
 *
 * `paid → refunded` only when the whole amount is refunded; partial refunds
 * only update `refundedCents`. A PI that isn't the order's bound PI (a stray
 * second PI) is released: holds canceled, captures refunded. Every release
 * (cancel/refund with a discrepancy) is tracked on the order until Stripe
 * shows the PI `isReleased`.
 */
import type { ObservedPaymentIntent, Order, OrderStatus } from '../types.js';
import { IS_TERMINAL } from '../types.js';

export type Step =
  | { kind: 'stay' }
  /** Amount/currency/orderId mismatch: no transition; flag + log. */
  | { kind: 'discrepancy'; detail: string }
  | { kind: 'transition'; status: OrderStatus; reason?: string; refundedCents?: number; discrepancy?: string }
  /** A hold exists for an order that wanted one: re-check, then approval or capture. */
  | { kind: 'hold' }
  /** Captured money on a link order that never got to approval: re-check → paid, else refund. */
  | { kind: 'recheck_paid' }
  | { kind: 'capture'; paymentIntentId: string }
  /** Cancel the PI. With `outcome`, the order enters `voiding` first. */
  | { kind: 'cancel'; paymentIntentId: string; outcome?: 'rejected' | 'expired' | 'canceled'; reason?: string; discrepancy?: string }
  /** Refund captured money; with `status`, the order is first committed to it (reason `discrepancy`). */
  | { kind: 'refund'; paymentIntentId: string; discrepancy: string; status?: OrderStatus };

const RELEASED: Record<string, true> = { canceled: true, requires_payment_method: true };

export function isUnpaidTerminal(status: OrderStatus): boolean {
  return IS_TERMINAL[status] && status !== 'paid' && status !== 'refunded';
}

/** Stripe holds none of this PI's money any more (hold released, or fully refunded). */
export function isReleased(pi: ObservedPaymentIntent): boolean {
  return RELEASED[pi.status] === true || (pi.status === 'succeeded' && pi.amountRefunded >= pi.amount);
}

/** Amount (integer minor units) and currency (case-insensitive) equal the frozen quote. */
export function matchesQuote(order: Order, pi: ObservedPaymentIntent): boolean {
  return pi.amount === order.quote.totalCents && pi.currency.toLowerCase() === order.quote.currency.toLowerCase();
}

function mismatchDetail(order: Order, pi: ObservedPaymentIntent): string {
  return `PaymentIntent ${pi.id} is ${String(pi.amount)} ${pi.currency}, order quote is ${String(order.quote.totalCents)} ${order.quote.currency}`;
}

/** Release a PaymentIntent that must not keep money (stray or on a dead order). */
function release(pi: ObservedPaymentIntent, discrepancy: string): Step {
  if (pi.status === 'requires_capture') return { kind: 'cancel', paymentIntentId: pi.id, discrepancy };
  if (pi.status === 'succeeded' && pi.amountRefunded < pi.amount) return { kind: 'refund', paymentIntentId: pi.id, discrepancy };
  return { kind: 'stay' };
}

export function decide(order: Order, pi: ObservedPaymentIntent): Step {
  if (pi.metadata['orderId'] !== order.id) {
    return { kind: 'discrepancy', detail: `PaymentIntent ${pi.id} metadata.orderId is ${pi.metadata['orderId'] ?? 'missing'}` };
  }
  const bound = order.stripe.paymentIntentId;
  if (bound !== undefined && bound !== pi.id) {
    return release(pi, `second PaymentIntent ${pi.id} for order ${order.id} (bound: ${bound})`);
  }

  const { status } = order;
  if (status === 'paid') {
    if (pi.amountRefunded > 0 && pi.amountRefunded >= pi.amount) {
      return { kind: 'transition', status: 'refunded', refundedCents: pi.amountRefunded };
    }
    if (pi.amountRefunded > 0 && pi.amountRefunded !== order.refundedCents) {
      return { kind: 'transition', status: 'paid', refundedCents: pi.amountRefunded };
    }
    return { kind: 'stay' };
  }
  if (status === 'refunded') return { kind: 'stay' };

  if (isUnpaidTerminal(status)) {
    const detail = matchesQuote(order, pi)
      ? `PaymentIntent ${pi.id} is ${pi.status} on ${status} order ${order.id}`
      : `${mismatchDetail(order, pi)} on ${status} order ${order.id}`;
    return release(pi, detail);
  }

  if (status === 'voiding') {
    if (pi.status === 'requires_capture') return { kind: 'cancel', paymentIntentId: pi.id };
    if (pi.status === 'succeeded') {
      const detail = `PaymentIntent ${pi.id} was captured while order ${order.id} was voiding`;
      // The owner said no: never keep the money, even though Stripe captured it.
      if (order.voidOutcome === 'rejected') {
        return isReleased(pi)
          ? { kind: 'transition', status: 'rejected', reason: 'discrepancy', discrepancy: detail }
          : { kind: 'refund', paymentIntentId: pi.id, discrepancy: detail, status: 'rejected' };
      }
      return { kind: 'transition', status: 'paid', reason: 'discrepancy', discrepancy: detail };
    }
    if (RELEASED[pi.status] === true) return { kind: 'transition', status: order.voidOutcome ?? 'canceled' };
    return { kind: 'stay' };
  }

  // Forward-moving states: never act on money that doesn't match the quote.
  if (!matchesQuote(order, pi)) return { kind: 'discrepancy', detail: mismatchDetail(order, pi) };

  switch (status) {
    case 'authorizing':
      if (pi.status === 'requires_capture') return { kind: 'hold' };
      if (pi.status === 'succeeded') return { kind: 'transition', status: 'paid' };
      if (RELEASED[pi.status] === true) return { kind: 'transition', status: 'payment_failed', reason: order.statusReason ?? 'payment_declined' };
      if (pi.status === 'requires_action') return { kind: 'cancel', paymentIntentId: pi.id, reason: 'requires_3ds' };
      return { kind: 'stay' };
    case 'awaiting_approval':
      if (pi.status === 'succeeded') return { kind: 'transition', status: 'paid' };
      if (RELEASED[pi.status] === true) return { kind: 'transition', status: 'expired', reason: 'authorization_lapsed' };
      return { kind: 'stay' };
    case 'capturing':
      if (pi.status === 'requires_capture') return { kind: 'capture', paymentIntentId: pi.id };
      if (pi.status === 'succeeded') return { kind: 'transition', status: 'paid' };
      if (RELEASED[pi.status] === true) return { kind: 'transition', status: 'payment_failed', reason: 'capture_failed' };
      return { kind: 'stay' };
    case 'awaiting_payment':
      if (pi.status === 'requires_capture') return { kind: 'hold' };
      if (pi.status === 'succeeded') return { kind: 'recheck_paid' };
      return { kind: 'stay' };
    default:
      return { kind: 'stay' };
  }
}
