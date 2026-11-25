import { describe, expect, it } from 'vitest';
import type { ObservedPaymentIntent, Order, OrderStatus } from '../types.js';
import { decide, isReleased } from './observe.js';
import type { Step } from './observe.js';

function order(status: OrderStatus, overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa',
    quoteId: 'qt_aaaaaaaaaaaaaaaaaaaaaaaa',
    offering: 'lesson',
    request: { answers: {}, selections: {} },
    quote: { currency: 'USD', lines: [], subtotalCents: 14600, taxCents: 0, totalCents: 14600 },
    confirmation: 'owner_approves',
    door: 'ucp',
    createdAt: '2026-07-01T00:00:00.000Z',
    stripe: { paymentIntentId: 'pi_1' },
    status,
    pendingHooks: [],
    version: 1,
    ...overrides,
  };
}

function pi(status: ObservedPaymentIntent['status'], overrides: Partial<ObservedPaymentIntent> = {}): ObservedPaymentIntent {
  return { id: 'pi_1', status, amount: 14600, currency: 'usd', metadata: { orderId: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa' }, amountRefunded: 0, ...overrides };
}

type Row = [ObservedPaymentIntent['status'], Partial<Record<OrderStatus, Step>>];

const CANCEL: Step = { kind: 'cancel', paymentIntentId: 'pi_1' };
const STAY: Step = { kind: 'stay' };

/** The observation table (observe.ts), cell by cell (terminal-unpaid = rejected/expired/canceled/payment_failed). */
const TABLE: Row[] = [
  ['requires_capture', {
    authorizing: { kind: 'hold' },
    awaiting_approval: STAY,
    capturing: { kind: 'capture', paymentIntentId: 'pi_1' },
    voiding: CANCEL,
    awaiting_payment: { kind: 'hold' },
  }],
  ['succeeded', {
    authorizing: { kind: 'transition', status: 'paid' },
    awaiting_approval: { kind: 'transition', status: 'paid' },
    capturing: { kind: 'transition', status: 'paid' },
    awaiting_payment: { kind: 'recheck_paid' },
  }],
  ['canceled', {
    authorizing: { kind: 'transition', status: 'payment_failed', reason: 'payment_declined' },
    awaiting_approval: { kind: 'transition', status: 'expired', reason: 'authorization_lapsed' },
    capturing: { kind: 'transition', status: 'payment_failed', reason: 'capture_failed' },
    voiding: { kind: 'transition', status: 'rejected' },
    awaiting_payment: STAY,
  }],
  ['requires_payment_method', {
    authorizing: { kind: 'transition', status: 'payment_failed', reason: 'payment_declined' },
    awaiting_approval: { kind: 'transition', status: 'expired', reason: 'authorization_lapsed' },
    capturing: { kind: 'transition', status: 'payment_failed', reason: 'capture_failed' },
    voiding: { kind: 'transition', status: 'rejected' },
    awaiting_payment: STAY,
  }],
  ['processing', { authorizing: STAY, awaiting_approval: STAY, capturing: STAY, voiding: STAY, awaiting_payment: STAY }],
  ['requires_action', { authorizing: { kind: 'cancel', paymentIntentId: 'pi_1', reason: 'requires_3ds' }, awaiting_payment: STAY }],
];

const UNPAID_TERMINAL: OrderStatus[] = ['rejected', 'expired', 'canceled', 'payment_failed'];

describe('observation table (decide)', () => {
  for (const [piStatus, cells] of TABLE) {
    for (const [orderStatus, expected] of Object.entries(cells)) {
      it(`${piStatus} × ${orderStatus}`, () => {
        expect(decide(order(orderStatus as OrderStatus, { voidOutcome: 'rejected' }), pi(piStatus))).toEqual(expected);
      });
    }
  }

  for (const status of UNPAID_TERMINAL) {
    it(`terminal-unpaid (${status}): requires_capture → void; succeeded → refund; released/processing → stay`, () => {
      expect(decide(order(status), pi('requires_capture'))).toMatchObject({ kind: 'cancel', paymentIntentId: 'pi_1' });
      expect(decide(order(status), pi('succeeded'))).toMatchObject({ kind: 'refund', paymentIntentId: 'pi_1' });
      expect(decide(order(status), pi('succeeded', { amountRefunded: 14600 }))).toEqual(STAY);
      expect(decide(order(status), pi('canceled'))).toEqual(STAY);
      expect(decide(order(status), pi('processing'))).toEqual(STAY);
      // Amount mismatch on a dead order: still released, with the mismatch in the discrepancy.
      const step = decide(order(status), pi('requires_capture', { amount: 1 }));
      expect(step).toMatchObject({ kind: 'cancel' });
      expect(step.kind === 'cancel' ? step.discrepancy : '').toContain('14600');
    });
  }

  it('voiding falls back to canceled when no outcome was recorded', () => {
    expect(decide(order('voiding'), pi('canceled'))).toEqual({ kind: 'transition', status: 'canceled' });
  });

  it('voiding + succeeded → paid with a discrepancy', () => {
    expect(decide(order('voiding'), pi('succeeded'))).toMatchObject({ kind: 'transition', status: 'paid', reason: 'discrepancy' });
  });

  it('voiding a REJECTED order + succeeded → rejected + refund (discrepancy), never paid', () => {
    const rejected = order('voiding', { voidOutcome: 'rejected' });
    expect(decide(rejected, pi('succeeded'))).toMatchObject({ kind: 'refund', paymentIntentId: 'pi_1', status: 'rejected' });
    expect(decide(rejected, pi('succeeded', { amountRefunded: 14600 }))).toMatchObject({ kind: 'transition', status: 'rejected', reason: 'discrepancy' });
    expect(decide(order('voiding', { voidOutcome: 'expired' }), pi('succeeded'))).toMatchObject({ kind: 'transition', status: 'paid', reason: 'discrepancy' });
    expect(decide(order('voiding', { voidOutcome: 'canceled' }), pi('succeeded'))).toMatchObject({ kind: 'transition', status: 'paid', reason: 'discrepancy' });
  });

  it('isReleased: released holds and fully refunded captures only', () => {
    expect(isReleased(pi('canceled'))).toBe(true);
    expect(isReleased(pi('requires_payment_method'))).toBe(true);
    expect(isReleased(pi('succeeded', { amountRefunded: 14600 }))).toBe(true);
    expect(isReleased(pi('succeeded', { amountRefunded: 5000 }))).toBe(false);
    expect(isReleased(pi('requires_capture'))).toBe(false);
    expect(isReleased(pi('processing'))).toBe(false);
  });

  it('authorizing keeps an earlier reason (requires_3ds) when the PI is finally canceled', () => {
    expect(decide(order('authorizing', { statusReason: 'requires_3ds' }), pi('canceled'))).toEqual({
      kind: 'transition',
      status: 'payment_failed',
      reason: 'requires_3ds',
    });
  });

  it('paid → refunded only on a full refund; partial refunds update refundedCents', () => {
    expect(decide(order('paid'), pi('succeeded'))).toEqual(STAY);
    expect(decide(order('paid'), pi('succeeded', { amountRefunded: 100 }))).toEqual({ kind: 'transition', status: 'paid', refundedCents: 100 });
    expect(decide(order('paid', { refundedCents: 100 }), pi('succeeded', { amountRefunded: 100 }))).toEqual(STAY);
    expect(decide(order('paid'), pi('succeeded', { amountRefunded: 14600 }))).toEqual({ kind: 'transition', status: 'refunded', refundedCents: 14600 });
    expect(decide(order('refunded'), pi('succeeded', { amountRefunded: 14600 }))).toEqual(STAY);
    expect(decide(order('paid'), pi('canceled'))).toEqual(STAY);
  });

  it('amount or currency mismatch on forward states: discrepancy, no transition', () => {
    for (const status of ['authorizing', 'awaiting_approval', 'capturing', 'awaiting_payment'] as const) {
      expect(decide(order(status), pi('requires_capture', { amount: 17001 })).kind).toBe('discrepancy');
      expect(decide(order(status), pi('succeeded', { currency: 'eur' })).kind).toBe('discrepancy');
    }
    // Currency compares case-insensitively.
    expect(decide(order('capturing'), pi('succeeded', { currency: 'USD' }))).toEqual({ kind: 'transition', status: 'paid' });
  });

  it('a PI for another order is never acted on', () => {
    expect(decide(order('capturing'), pi('requires_capture', { metadata: { orderId: 'ord_other' } })).kind).toBe('discrepancy');
    expect(decide(order('rejected'), pi('succeeded', { metadata: {} })).kind).toBe('discrepancy');
  });

  it('a second PI for a bound order is released (cancel hold, refund capture)', () => {
    expect(decide(order('awaiting_approval'), pi('requires_capture', { id: 'pi_2' }))).toMatchObject({ kind: 'cancel', paymentIntentId: 'pi_2' });
    expect(decide(order('paid'), pi('succeeded', { id: 'pi_2' }))).toMatchObject({ kind: 'refund', paymentIntentId: 'pi_2' });
    expect(decide(order('paid'), pi('canceled', { id: 'pi_2' }))).toEqual(STAY);
  });
});
