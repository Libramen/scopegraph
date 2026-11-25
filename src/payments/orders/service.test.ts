import { describe, expect, it } from 'vitest';
import { evaluate } from '../../engine/index.js';
import type { Order, ScopedRequest } from '../types.js';
import { DefinitiveGatewayError, IS_TERMINAL } from '../types.js';
import { MAX_RELEASE_ATTEMPTS } from './releases.js';
import { MAX_OPEN_UNPAID_ORDERS_PER_DOOR, MAX_UNPAID_PER_CLIENT, MAX_UNPAID_PER_NETWORK, clientNetwork } from './funnel.js';
import { MAX_MEMORY_QUOTES, MemoryBackend } from '../store/index.js';
import { lessonGraph, makeHarness, START } from './test-harness.js';
import type { Harness } from './test-harness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SPT = 'spt_test_secretToken_ABC123';
const BUYER = { name: 'Ada Buyer', email: 'ada@example.com', phone: '+15555550100' };

async function pay(h: Harness, quoteId: string, overrides: Partial<Parameters<Harness['service']['payWithSpt']>[0]> = {}) {
  return h.service.payWithSpt({ quoteId, door: 'ucp', spt: SPT, buyer: BUYER, checkoutId: 'chk_test', ...overrides });
}

async function awaitingApproval(h: Harness): Promise<Order> {
  const quote = await h.quote();
  const result = await pay(h, quote.id);
  if (!result.ok) throw new Error(result.message);
  expect(result.value.status).toBe('awaiting_approval');
  return result.value;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  return result.value;
}

describe('quotes and the funnel', () => {
  it('only stores quotes of at least 50 minor units', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    expect(quote.id).toMatch(/^qt_[a-z2-7]{24}$/);
    expect(quote.quote.totalCents).toBe(14600);
    expect(quote.expiresAt).toBe(new Date(START.getTime() + 30 * MIN).toISOString());
    await expect(h.quote({}, 'sticker')).rejects.toThrow('not payable');
  });

  it('refuses unknown and expired quotes', async () => {
    const h = await makeHarness();
    expect(await pay(h, 'qt_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ ok: false, error: 'quote_not_found' });
    const quote = await h.quote();
    h.clock.advance(30 * MIN);
    expect(await pay(h, quote.id)).toMatchObject({ ok: false, error: 'quote_expired' });
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('re-evaluates with fresh facts; a changed outcome refuses and expires the quote', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.facts['tide'] = 'high';
    expect(await pay(h, quote.id)).toMatchObject({ ok: false, error: 'requote_required' });
    expect(h.store.getQuote(quote.id)?.expiresAt).toBe(h.clock.now.toISOString());
    expect(h.gateway.callsOf('authorizeSpt')).toHaveLength(0);
  });

  it('a price change since the quote refuses (requote_required)', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.graph.current = lessonGraph({ priceCents: 9000 });
    expect(await pay(h, quote.id)).toMatchObject({ ok: false, error: 'requote_required' });
    expect(await h.service.startLinkOrder(quote.id)).toMatchObject({ ok: false, error: 'quote_expired' });
  });

  it('caps a quote at 3 orders; failed orders free the quote until then', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.authorizeStatus = 'requires_payment_method';
    for (let i = 0; i < 3; i++) {
      const order = ok(await pay(h, quote.id, { spt: `spt_attempt_${String(i)}` }));
      expect(order.status).toBe('payment_failed');
    }
    expect(await pay(h, quote.id, { spt: 'spt_attempt_4' })).toMatchObject({ ok: false, error: 'too_many_attempts' });
  });

  it('one live order per quote — a second door is refused', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    ok(await h.service.startLinkOrder(quote.id));
    expect(await pay(h, quote.id)).toMatchObject({ ok: false, error: 'quote_in_use' });

    const other = await h.quote();
    ok(await pay(h, other.id));
    expect(await h.service.startLinkOrder(other.id)).toMatchObject({ ok: false, error: 'quote_in_use' });
    expect(await pay(h, other.id, { door: 'acp' })).toMatchObject({ ok: false, error: 'quote_in_use' });
    expect(await pay(h, other.id, { checkoutId: 'chk_other' })).toMatchObject({ ok: false, error: 'quote_in_use' });
  });

  it('owner_approves on UCP/ACP requires the buyer email; instant does not', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    expect(await pay(h, quote.id, { buyer: { name: 'No Email' } })).toMatchObject({ ok: false, error: 'buyer_email_required' });
    const instant = await makeHarness({ config: { confirmation: 'instant' } });
    const q2 = await instant.quote();
    expect(ok(await instant.service.payWithSpt({ quoteId: q2.id, door: 'ucp', spt: SPT })).status).toBe('paid');
  });
});

describe('SPT authorization', () => {
  it('charges exactly the frozen quote (amount, lowercase currency, manual capture)', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const order = ok(await pay(h, quote.id));
    const [call] = h.gateway.callsOf('authorizeSpt');
    expect(call?.args).toMatchObject({ amount: 14600, currency: 'usd', captureMethod: 'manual', receiptEmail: BUYER.email });
    expect(order.quote).toEqual(quote.quote);
    const pi = h.gateway.intents.get(order.stripe.paymentIntentId ?? '');
    expect(pi).toMatchObject({ amount: 14600, currency: 'usd', metadata: { orderId: order.id, quoteId: quote.id } });
  });

  it('owner_approves: hold → awaiting_approval with deadline + onApprovalNeeded links', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    expect(order.approvalDeadline).toBe(new Date(START.getTime() + 24 * HOUR).toISOString());
    expect(order.buyer).toEqual(BUYER);
    expect(order.door).toBe('ucp');
    expect(order.checkoutId).toBe('chk_test');
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onApprovalNeeded']);
    const links = h.hookCalls[0]?.links;
    expect(links?.approveUrl).toMatch(new RegExp(`^https://book\\.example\\.com/orders/${order.id}/approve\\?t=`));
    expect(links?.rejectUrl).toMatch(new RegExp(`/orders/${order.id}/reject\\?t=`));
    expect(links?.expiresAt).toBe(order.approvalDeadline);
    expect(h.store.getOrder(order.id)?.pendingHooks).toEqual([]);
  });

  it('instant: re-checked, captured, paid', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    const order = ok(await pay(h, quote.id));
    expect(order.status).toBe('paid');
    expect(h.gateway.callsOf('capture')).toHaveLength(1);
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onPaid']);
  });

  it('the raw SPT is never persisted; only its SHA-256 fingerprint', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    expect(order.stripe.tokenFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.backend.text).not.toContain(SPT);
    expect(h.backend.text).not.toContain('secretToken');
  });

  it('ambiguous authorization stays authorizing; same-SPT retry re-issues the same key (one PI)', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    const first = ok(await pay(h, quote.id));
    expect(first.status).toBe('authorizing');
    expect(first.stripe.paymentIntentId).toBeUndefined();
    const second = ok(await pay(h, quote.id));
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('awaiting_approval');
    const calls = h.gateway.callsOf('authorizeSpt');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args['fingerprint']).toBe(calls[1]?.args['fingerprint']);
    expect(h.gateway.intents.size).toBe(1);
  });

  it('a different SPT on an order with a credential is refused', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    expect(await pay(h, order.quoteId, { spt: 'spt_another' })).toMatchObject({ ok: false, error: 'different_credential' });
    // Same SPT again is an idempotent replay.
    expect(ok(await pay(h, order.quoteId)).id).toBe(order.id);
    expect(h.gateway.callsOf('authorizeSpt')).toHaveLength(1);
  });

  it('N concurrent completes create one order and one PaymentIntent', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(h, quote.id)));
    const ids = new Set(results.map((r) => ok(r).id));
    expect(ids.size).toBe(1);
    expect(h.gateway.intents.size).toBe(1);
    expect(h.store.ordersForQuote(quote.id)).toHaveLength(1);

    const q2 = await h.quote();
    const mixed = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(h, q2.id, { spt: `spt_card_${String(i)}` })));
    expect(mixed.filter((r) => r.ok)).toHaveLength(1);
    expect(mixed.filter((r) => !r.ok && r.error === 'different_credential')).toHaveLength(4);
    expect(h.gateway.intents.size).toBe(2);
  });

  it('a decline is payment_failed (scrubbed code) and frees the quote', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', new DefinitiveGatewayError('Your card was declined: spt_test_secretToken_ABC123', 'card_declined'));
    const failed = ok(await pay(h, quote.id));
    expect(failed).toMatchObject({ status: 'payment_failed', statusReason: 'card_declined' });
    expect(h.logs.join('\n')).not.toContain('secretToken');
    const retry = ok(await pay(h, quote.id, { spt: 'spt_second_card' }));
    expect(retry.status).toBe('awaiting_approval');
    expect(retry.id).not.toBe(failed.id);
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onClosed', 'onApprovalNeeded']);
  });

  it('requires_action: the PI is canceled and the order fails with requires_3ds', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.authorizeStatus = 'requires_action';
    const order = ok(await pay(h, quote.id));
    expect(order).toMatchObject({ status: 'payment_failed', statusReason: 'requires_3ds' });
    expect(h.gateway.callsOf('cancel')).toHaveLength(1);
  });

  it('a re-check failure after the hold voids it (canceled, requote_required)', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    let calls = 0;
    // Facts flip between the funnel re-check and the post-hold re-check.
    Object.defineProperty(h.facts, 'tide', { enumerable: true, get: () => (calls++ === 0 ? 'low' : 'high') });
    const order = ok(await pay(h, quote.id));
    expect(order).toMatchObject({ status: 'canceled', voidOutcome: 'canceled', statusReason: 'requote_required' });
    expect(h.gateway.intents.get(order.stripe.paymentIntentId ?? '')?.status).toBe('canceled');
    expect(h.gateway.callsOf('capture')).toHaveLength(0);
  });

  it('requireSettled needs instant and voids anything that did not settle', async () => {
    const approving = await makeHarness();
    const q0 = await approving.quote();
    expect(await approving.service.payWithSpt({ quoteId: q0.id, door: 'mpp', spt: SPT, requireSettled: true }))
      .toMatchObject({ ok: false, error: 'door_unavailable' });

    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const q1 = await h.quote();
    expect(ok(await h.service.payWithSpt({ quoteId: q1.id, door: 'mpp', spt: SPT, requireSettled: true })).status).toBe('paid');

    const q2 = await h.quote();
    h.gateway.failNext('capture', 'ambiguous');
    const unsettled = await h.service.payWithSpt({ quoteId: q2.id, door: 'mpp', spt: 'spt_other', requireSettled: true });
    expect(unsettled).toMatchObject({ ok: false, error: 'payment_declined' });
    const order = h.store.ordersForQuote(q2.id)[0];
    expect(order?.status).toBe('canceled');
    expect(h.gateway.intents.get(order?.stripe.paymentIntentId ?? '')?.status).toBe('canceled');
  });
});

describe('approval deadline', () => {
  it('is bounded by serviceStart − 1h for a date-time request', async () => {
    const h = await makeHarness();
    const quote = await h.quote({ answers: { participants: 2 }, date: '2026-07-02T03:00:00-07:00' });
    const order = ok(await pay(h, quote.id));
    expect(order.approvalDeadline).toBe('2026-07-02T09:00:00.000Z');
  });

  it('uses the start of the local day (business timezone) for a date-only request', async () => {
    const h = await makeHarness();
    const quote = await h.quote({ answers: { participants: 2 }, date: '2026-07-02' });
    const order = ok(await pay(h, quote.id));
    // Midnight in Los Angeles (UTC−7 in July) minus one hour.
    expect(order.approvalDeadline).toBe('2026-07-02T06:00:00.000Z');
  });

  it('is bounded by capture_before − 1h', async () => {
    const h = await makeHarness();
    h.gateway.captureBefore = new Date(START.getTime() + 10 * HOUR).toISOString();
    const order = await awaitingApproval(h);
    expect(order.approvalDeadline).toBe(new Date(START.getTime() + 9 * HOUR).toISOString());
  });

  it('a deadline under 5 minutes away voids the hold (date_too_soon)', async () => {
    const h = await makeHarness();
    const quote = await h.quote({ answers: { participants: 2 }, date: new Date(START.getTime() + 10 * HOUR).toISOString() });
    // Stripe would release the hold 64 minutes from now: the owner gets 4 minutes.
    h.gateway.captureBefore = new Date(START.getTime() + HOUR + 4 * MIN).toISOString();
    const order = ok(await pay(h, quote.id));
    expect(order).toMatchObject({ status: 'canceled', statusReason: 'date_too_soon' });
    expect(h.gateway.callsOf('cancel')).toHaveLength(1);
  });

  it('owner_approves quotes are not payable when a hold at quote expiry would leave under 5 minutes to approve', async () => {
    const h = await makeHarness(); // quoteTtlMinutes 30
    const result = (date: Date) => {
      const scoped = evaluate(h.graph.current, { offering: 'lesson', answers: { participants: 2 }, date: date.toISOString(), facts: {} }, { now: START, trace: false });
      if (scoped.status !== 'qualified') throw new Error(scoped.status);
      return h.service.createQuote('lesson', scoped.summary, scoped.quote);
    };
    // start − 1h = expiry + 4 min → not payable; expiry + 5 min → payable.
    expect(await result(new Date(START.getTime() + HOUR + 34 * MIN))).toBeUndefined();
    expect(await result(new Date(START.getTime() + HOUR + 35 * MIN))).toBeDefined();
    // instant settles at once: no approval deadline, so the same booking stays payable.
    const instant = await makeHarness({ config: { confirmation: 'instant' } });
    const scoped = evaluate(instant.graph.current, { offering: 'lesson', answers: { participants: 2 }, date: new Date(START.getTime() + HOUR + 34 * MIN).toISOString(), facts: {} }, { now: START, trace: false });
    if (scoped.status !== 'qualified') throw new Error(scoped.status);
    expect(await instant.service.createQuote('lesson', scoped.summary, scoped.quote)).toBeDefined();
  });

  it('a payment link is refused when its Checkout Session would outlive the time the owner needs to approve', async () => {
    const h = await makeHarness(); // quoteTtlMinutes 30; link sessions last at least 31 minutes
    // Approval closes at start − 1h = START + 40 min: payable when quoted at START.
    const quote = await h.quote({ answers: { participants: 2 }, date: new Date(START.getTime() + HOUR + 40 * MIN).toISOString() });
    h.clock.advance(20 * MIN); // quote still valid, but a session opened now runs to START + 51 min
    expect(await h.service.startLinkOrder(quote.id)).toMatchObject({ ok: false, error: 'requote_required' });
    expect(h.store.ordersForQuote(quote.id)).toHaveLength(0);
  });

  it('approve after the deadline never captures — it releases the hold (expired)', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    h.clock.advance(24 * HOUR);
    const result = ok(await h.service.approve(order.id));
    expect(result).toMatchObject({ status: 'expired', statusReason: 'approval_deadline_passed' });
    expect(h.gateway.callsOf('capture')).toHaveLength(0);
    expect(h.gateway.intents.get(order.stripe.paymentIntentId ?? '')?.status).toBe('canceled');
  });

  it('the reconciler voids awaiting_approval orders past their deadline', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    h.clock.advance(24 * HOUR - MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)?.status).toBe('awaiting_approval');
    h.clock.advance(MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'expired', voidOutcome: 'expired' });
  });
});

describe('owner and buyer actions', () => {
  it('approve captures once and is idempotent', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    expect(ok(await h.service.approve(order.id)).status).toBe('paid');
    expect(ok(await h.service.approve(order.id)).status).toBe('paid');
    expect(h.gateway.callsOf('capture')).toHaveLength(1);
    expect(await h.service.reject(order.id)).toMatchObject({ ok: false, error: 'invalid_state' });
    expect(await h.service.approve('ord_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ ok: false, error: 'order_not_found' });
  });

  it('reject releases the hold, stores the reason scrubbed, fires onClosed', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    const rejected = ok(await h.service.reject(order.id, `  Fully booked, sorry (ref spt_leaked_token_123) ${'x'.repeat(600)}`));
    expect(rejected.status).toBe('rejected');
    expect(rejected.statusReason).toContain('spt_[REDACTED]');
    expect(rejected.statusReason?.length).toBe(500);
    expect(ok(await h.service.reject(order.id)).status).toBe('rejected');
    expect(h.gateway.callsOf('cancel')).toHaveLength(1);
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onApprovalNeeded', 'onClosed']);
  });

  it('buyer cancel: awaiting_approval voids; in-flight and paid are refused', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    expect(ok(await h.service.cancel(order.id))).toMatchObject({ status: 'canceled', voidOutcome: 'canceled' });
    expect(ok(await h.service.cancel(order.id)).status).toBe('canceled');

    const q = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous');
    const authorizing = ok(await pay(h, q.id, { spt: 'spt_x' }));
    expect(await h.service.cancel(authorizing.id)).toMatchObject({ ok: false, error: 'invalid_state' });

    const paid = await awaitingApproval(h);
    ok(await h.service.approve(paid.id));
    expect(await h.service.cancel(paid.id)).toMatchObject({ ok: false, error: 'invalid_state' });
  });

  it('concurrent approve / reject / deadline sweep produce exactly one outcome', async () => {
    for (const offset of [-1, 1]) {
      const h = await makeHarness();
      const order = await awaitingApproval(h);
      h.clock.advance(24 * HOUR + offset);
      const results = await Promise.all([
        h.service.approve(order.id),
        h.service.reject(order.id, 'no'),
        h.service.reconcile(),
        h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: order.stripe.paymentIntentId ?? '', metadata: { orderId: order.id } }),
      ]);
      const final = h.store.getOrder(order.id);
      expect(final !== undefined && IS_TERMINAL[final.status]).toBe(true);
      const pi = h.gateway.intents.get(order.stripe.paymentIntentId ?? '');
      if (final?.status === 'paid') expect(pi?.status).toBe('succeeded');
      else expect(pi?.status).toBe('canceled');
      if (offset > 0) expect(final?.status).not.toBe('paid');
      const okResults = results.slice(0, 2).filter((r) => r !== undefined && typeof r === 'object' && 'ok' in r && r.ok);
      expect(okResults.length).toBeLessThanOrEqual(1);
      await h.service.drainHooks();
      const terminalHooks = h.hookCalls.filter((c) => c.hook === 'onPaid' || c.hook === 'onClosed');
      expect(terminalHooks).toHaveLength(1);
    }
  });
});

describe('observation table through the service (webhook triggers)', () => {
  async function trigger(h: Harness, order: Order, type = 'payment_intent.succeeded'): Promise<Order> {
    await h.service.handleStripeTrigger({ type, objectId: order.stripe.paymentIntentId ?? '', metadata: { orderId: order.id } });
    const current = h.store.getOrder(order.id);
    if (current === undefined) throw new Error('order vanished');
    return current;
  }

  it('awaiting_approval: requires_capture no-op; succeeded → paid; canceled → expired', async () => {
    const h = await makeHarness();
    const a = await awaitingApproval(h);
    expect((await trigger(h, a, 'payment_intent.amount_capturable_updated')).status).toBe('awaiting_approval');
    h.gateway.setIntent(a.stripe.paymentIntentId ?? '', { status: 'succeeded' });
    expect((await trigger(h, a)).status).toBe('paid');

    const b = await awaitingApproval(h);
    h.gateway.setIntent(b.stripe.paymentIntentId ?? '', { status: 'canceled' });
    expect(await trigger(h, b, 'payment_intent.canceled')).toMatchObject({ status: 'expired', statusReason: 'authorization_lapsed' });
  });

  it('capturing: requires_capture retries capture; canceled → payment_failed', async () => {
    const h = await makeHarness();
    const a = await awaitingApproval(h);
    h.gateway.failNext('capture', 'ambiguous', 2);
    expect(ok(await h.service.approve(a.id)).status).toBe('capturing');
    expect((await trigger(h, a, 'payment_intent.amount_capturable_updated')).status).toBe('paid');
    expect(h.gateway.callsOf('capture')).toHaveLength(3);

    const b = await awaitingApproval(h);
    h.gateway.failNext('capture', 'ambiguous', 2);
    ok(await h.service.approve(b.id));
    h.gateway.setIntent(b.stripe.paymentIntentId ?? '', { status: 'canceled' });
    expect(await trigger(h, b, 'payment_intent.canceled')).toMatchObject({ status: 'payment_failed', statusReason: 'capture_failed' });
  });

  it('voiding: requires_capture retries cancel → voidOutcome; succeeded (buyer cancel) → paid + discrepancy', async () => {
    const h = await makeHarness();
    const a = await awaitingApproval(h);
    h.gateway.failNext('cancel', 'ambiguous', 2);
    expect(ok(await h.service.reject(a.id)).status).toBe('voiding');
    expect((await trigger(h, a, 'payment_intent.amount_capturable_updated')).status).toBe('rejected');

    const b = await awaitingApproval(h);
    h.gateway.failNext('cancel', 'ambiguous', 2);
    expect(ok(await h.service.cancel(b.id))).toMatchObject({ status: 'voiding', voidOutcome: 'canceled' });
    h.gateway.setIntent(b.stripe.paymentIntentId ?? '', { status: 'succeeded' });
    expect(await trigger(h, b)).toMatchObject({ status: 'paid', statusReason: 'discrepancy' });
    expect(h.logs.some((l) => l.includes('DISCREPANCY'))).toBe(true);
  });

  it('captured while voiding a REJECTED order → rejected + refunded + discrepancy, never paid', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    const piId = order.stripe.paymentIntentId ?? '';
    h.gateway.failNext('cancel', 'ambiguous', 2);
    expect(ok(await h.service.reject(order.id, 'Fully booked')).status).toBe('voiding');
    h.gateway.setIntent(piId, { status: 'succeeded' });
    const after = await trigger(h, order);
    expect(after).toMatchObject({ status: 'rejected', statusReason: 'discrepancy' });
    expect(after.releases).toBeUndefined();
    expect(h.gateway.intents.get(piId)?.amountRefunded).toBe(14600);
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onApprovalNeeded', 'onClosed']);
    expect(h.logs.some((l) => l.includes('DISCREPANCY') && l.includes('captured while order'))).toBe(true);
  });

  it('captured while voiding an expired hold → paid + discrepancy', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    h.clock.advance(24 * HOUR);
    h.gateway.failNext('cancel', 'ambiguous', 2);
    expect(ok(await h.service.approve(order.id))).toMatchObject({ status: 'voiding', voidOutcome: 'expired' });
    h.gateway.setIntent(order.stripe.paymentIntentId ?? '', { status: 'succeeded' });
    expect(await trigger(h, order)).toMatchObject({ status: 'paid', statusReason: 'discrepancy' });
  });

  it('authorizing: succeeded → paid; canceled → payment_failed; processing → stay; requires_action → cancel → payment_failed', async () => {
    for (const [status, expected] of [
      ['succeeded', 'paid'],
      ['canceled', 'payment_failed'],
      ['requires_payment_method', 'payment_failed'],
      ['processing', 'authorizing'],
      ['requires_action', 'payment_failed'],
      ['requires_capture', 'awaiting_approval'],
    ] as const) {
      const h = await makeHarness();
      const quote = await h.quote();
      h.gateway.authorizeStatus = status;
      h.gateway.failNext('authorizeSpt', 'ambiguous_after');
      const order = ok(await pay(h, quote.id));
      expect(order.status).toBe('authorizing');
      const [pi] = h.gateway.intents.values();
      await h.service.handleStripeTrigger({ type: 'payment_intent.succeeded', objectId: pi?.id ?? '', metadata: { orderId: order.id } });
      const after = h.store.getOrder(order.id);
      expect(after?.status).toBe(expected);
      expect(after?.stripe.paymentIntentId).toBe(pi?.id);
    }
  });

  it('terminal-unpaid: a hold is canceled, captured money refunded (discrepancy), released PIs ignored', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    ok(await h.service.reject(order.id));
    const piId = order.stripe.paymentIntentId ?? '';
    h.gateway.setIntent(piId, { status: 'requires_capture' });
    const afterHold = await trigger(h, order, 'payment_intent.amount_capturable_updated');
    expect(afterHold.status).toBe('rejected');
    expect(h.gateway.intents.get(piId)?.status).toBe('canceled');

    h.gateway.setIntent(piId, { status: 'succeeded', amountRefunded: 0 });
    const afterCapture = await trigger(h, order);
    expect(afterCapture).toMatchObject({ status: 'rejected', statusReason: 'discrepancy' });
    expect(h.gateway.intents.get(piId)?.amountRefunded).toBe(14600);
    const refunds = h.gateway.callsOf('refund').length;
    await trigger(h, order, 'charge.refunded');
    expect(h.gateway.callsOf('refund')).toHaveLength(refunds);
  });

  it('paid: full refund → refunded (onClosed); partial refund only records refundedCents', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    ok(await h.service.approve(order.id));
    const piId = order.stripe.paymentIntentId ?? '';
    h.gateway.setIntent(piId, { amountRefunded: 5000 });
    expect(await trigger(h, order, 'charge.refunded')).toMatchObject({ status: 'paid', refundedCents: 5000 });
    h.gateway.setIntent(piId, { amountRefunded: 14600 });
    expect(await trigger(h, order, 'charge.refunded')).toMatchObject({ status: 'refunded', refundedCents: 14600 });
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onApprovalNeeded', 'onPaid', 'onClosed']);
  });

  it('an amount mismatch never transitions; the order is flagged', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.nextAuthorize = { amount: 999_999 };
    const order = ok(await pay(h, quote.id));
    expect(order).toMatchObject({ status: 'authorizing', statusReason: 'discrepancy' });
    expect(order.stripe.paymentIntentId).toBeUndefined();
    expect(h.logs.some((l) => l.includes('DISCREPANCY') && l.includes('999999'))).toBe(true);
  });

  it('a second PaymentIntent for a bound order is released', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    const stray = h.gateway.addIntent({ status: 'requires_capture', amount: 14600, currency: 'usd', metadata: { orderId: order.id }, amountRefunded: 0 });
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: stray.id, metadata: { orderId: order.id } });
    expect(h.gateway.intents.get(stray.id)?.status).toBe('canceled');
    expect(h.store.getOrder(order.id)?.status).toBe('awaiting_approval');
  });

  it('unknown orders are a no-op without calling Stripe', async () => {
    const h = await makeHarness();
    await h.service.handleStripeTrigger({ type: 'payment_intent.succeeded', objectId: 'pi_x', metadata: { orderId: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect(h.gateway.calls).toHaveLength(0);
  });
});

describe('payment link orders', () => {
  it('persists the session expiry before the call and is idempotent per quote', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const first = ok(await h.service.startLinkOrder(quote.id));
    expect(first.order).toMatchObject({ status: 'awaiting_payment', door: 'link', paymentUrl: first.url });
    const stored = h.store.getOrder(first.order.id);
    const expected = new Date(START.getTime() + 31 * MIN).toISOString();
    expect(stored?.stripe.checkoutSessionExpiresAt).toBe(expected);
    expect(h.gateway.callsOf('createCheckoutSession')[0]?.args).toMatchObject({
      expiresAt: expected,
      offeringName: 'Surf Lesson',
      successUrl: `https://book.example.com/orders/${first.order.id}`,
    });
    const again = ok(await h.service.startLinkOrder(quote.id));
    expect(again.url).toBe(first.url);
    expect(h.gateway.callsOf('createCheckoutSession')).toHaveLength(1);
  });

  it('an ambiguous session create is retried with the same key and expiry', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.failNext('createCheckoutSession', 'ambiguous_after');
    expect(await h.service.startLinkOrder(quote.id)).toMatchObject({ ok: false, error: 'door_unavailable' });
    h.clock.advance(MIN);
    const retry = ok(await h.service.startLinkOrder(quote.id));
    expect(h.gateway.sessions.size).toBe(1);
    const calls = h.gateway.callsOf('createCheckoutSession');
    expect(calls[0]?.args['expiresAt']).toBe(calls[1]?.args['expiresAt']);
    expect(retry.url).toContain('cs_fake_');
  });

  it('completion: re-check → awaiting_approval with the buyer from Stripe', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    const sessionId = h.store.getOrder(order.id)?.stripe.checkoutSessionId ?? '';
    h.gateway.payCheckoutSession(sessionId, { customer: { name: 'Link Buyer', email: 'link@example.com' } });
    await h.service.handleStripeTrigger({ type: 'checkout.session.completed', objectId: sessionId, metadata: { orderId: order.id } });
    const after = h.store.getOrder(order.id);
    expect(after).toMatchObject({ status: 'awaiting_approval', buyer: { name: 'Link Buyer', email: 'link@example.com' } });
    expect(h.service.toPublic(after as Order).paymentUrl).toBeUndefined();
  });

  it('completion via the PI event first still records the buyer', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    const sessionId = h.store.getOrder(order.id)?.stripe.checkoutSessionId ?? '';
    const pi = h.gateway.payCheckoutSession(sessionId, { customer: { email: 'first@example.com' } });
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: pi.id, metadata: { orderId: order.id } });
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'awaiting_approval', buyer: { email: 'first@example.com' }, stripe: { paymentIntentId: pi.id } });
  });

  it('completion via the PI event first cleans the Stripe buyer like the session event does', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    const sessionId = h.store.getOrder(order.id)?.stripe.checkoutSessionId ?? '';
    const pi = h.gateway.payCheckoutSession(sessionId, {
      customer: { name: `Ada\u001b[2J\u202eLovelace\u2028${'x'.repeat(400)}`, email: 'first@example.com\u0007', phone: 'n/a\u2066' },
    });
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: pi.id, metadata: { orderId: order.id } });
    const buyer = h.store.getOrder(order.id)?.buyer;
    expect(buyer?.email).toBe('first@example.com');
    expect(buyer?.phone).toBe('n/a');
    expect(buyer?.name).toBe(`Ada[2JLovelace${'x'.repeat(320 - 'Ada[2JLovelace'.length)}`);
  });

  it('completion with a failed re-check voids the hold (requote_required)', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    const sessionId = h.store.getOrder(order.id)?.stripe.checkoutSessionId ?? '';
    const pi = h.gateway.payCheckoutSession(sessionId);
    h.facts['tide'] = 'high';
    await h.service.handleStripeTrigger({ type: 'checkout.session.completed', objectId: sessionId, metadata: { orderId: order.id } });
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'canceled', statusReason: 'requote_required' });
    expect(h.gateway.intents.get(pi.id)?.status).toBe('canceled');
  });

  it('awaiting_payment: succeeded re-checks → paid, or refund + discrepancy; canceled stays', async () => {
    const h = await makeHarness();
    const q1 = await h.quote();
    const one = ok(await h.service.startLinkOrder(q1.id)).order;
    const pi1 = h.gateway.payCheckoutSession(h.store.getOrder(one.id)?.stripe.checkoutSessionId ?? '', { status: 'canceled' });
    await h.service.handleStripeTrigger({ type: 'payment_intent.canceled', objectId: pi1.id, metadata: { orderId: one.id } });
    expect(h.store.getOrder(one.id)?.status).toBe('awaiting_payment');
    h.gateway.setIntent(pi1.id, { status: 'succeeded' });
    await h.service.handleStripeTrigger({ type: 'payment_intent.succeeded', objectId: pi1.id, metadata: { orderId: one.id } });
    expect(h.store.getOrder(one.id)?.status).toBe('paid');

    const q2 = await h.quote();
    const two = ok(await h.service.startLinkOrder(q2.id)).order;
    const pi2 = h.gateway.payCheckoutSession(h.store.getOrder(two.id)?.stripe.checkoutSessionId ?? '', { status: 'succeeded' });
    h.facts['tide'] = 'high';
    await h.service.handleStripeTrigger({ type: 'payment_intent.succeeded', objectId: pi2.id, metadata: { orderId: two.id } });
    expect(h.store.getOrder(two.id)).toMatchObject({ status: 'canceled', statusReason: 'discrepancy' });
    expect(h.gateway.intents.get(pi2.id)?.amountRefunded).toBe(14600);
  });

  it('reconciler: an unpaid session past expiry is expired at Stripe first, then the order', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    h.clock.advance(31 * MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'expired', statusReason: 'checkout_expired' });
    expect(h.gateway.callsOf('expireCheckoutSession')).toHaveLength(1);
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onClosed']);
  });

  it('reconciler: a session completed at the last second runs completion instead of expiring', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    h.gateway.payCheckoutSession(h.store.getOrder(order.id)?.stripe.checkoutSessionId ?? '', { customer: { email: 'late@example.com' } });
    h.clock.advance(32 * MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)?.status).toBe('awaiting_approval');
  });

  it('buyer cancel of an unpaid link order expires the session first', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    expect(ok(await h.service.cancel(order.id)).status).toBe('canceled');
    expect(h.gateway.callsOf('expireCheckoutSession')).toHaveLength(1);
    // The quote is free again for another door.
    expect(ok(await pay(h, quote.id)).status).toBe('awaiting_approval');
  });
});

describe('reconciler and crash recovery', () => {
  it('crash between durable authorizing and Stripe: restart binds the PI by metadata search', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    const order = ok(await pay(h, quote.id));
    expect(order.status).toBe('authorizing');
    // Durable before the Stripe call returned.
    const persisted = JSON.parse(h.backend.text ?? '{}') as { orders: Record<string, Order> };
    expect(persisted.orders[order.id]?.status).toBe('authorizing');

    const restarted = await h.restart();
    h.clock.advance(MIN);
    await restarted.service.reconcile();
    expect(restarted.store.getOrder(order.id)?.status).toBe('authorizing');
    expect(restarted.gateway.callsOf('findPaymentIntentsByOrder')).toHaveLength(0);
    h.clock.advance(2 * MIN);
    await restarted.service.reconcile();
    const after = restarted.store.getOrder(order.id);
    expect(after?.status).toBe('awaiting_approval');
    expect(after?.stripe.paymentIntentId).toMatch(/^pi_fake_/);
    expect(h.gateway.intents.size).toBe(1);
  });

  it('an authorization never seen by Stripe fails 24h after the attempt', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous');
    const order = ok(await pay(h, quote.id));
    h.clock.advance(3 * MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)?.status).toBe('authorizing');
    h.clock.advance(24 * HOUR);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'payment_failed', statusReason: 'authorization_not_found' });
  });

  it('an ambiguous capture is reconciled from Stripe, never assumed', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    h.gateway.failNext('capture', 'ambiguous_after');
    h.gateway.failNext('retrievePaymentIntent', 'ambiguous');
    expect(ok(await h.service.approve(order.id)).status).toBe('capturing');
    h.clock.advance(3 * MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)?.status).toBe('paid');
    expect(h.gateway.callsOf('capture')).toHaveLength(1);
  });
});

describe('hooks', () => {
  it('are recorded in the transition write and retried by the reconciler, giving up after 5', async () => {
    const h = await makeHarness();
    h.failHooks.remaining = 100;
    const order = await awaitingApproval(h);
    const persisted = JSON.parse(h.backend.text ?? '{}') as { orders: Record<string, Order> };
    expect(persisted.orders[order.id]?.pendingHooks.map((p) => p.hook)).toContain('onApprovalNeeded');
    await h.service.drainHooks();
    expect(h.store.getOrder(order.id)?.pendingHooks).toEqual([{ hook: 'onApprovalNeeded', attempts: 1 }]);
    for (let i = 0; i < 4; i++) {
      await h.service.reconcile();
      await h.service.drainHooks();
    }
    expect(h.store.getOrder(order.id)?.pendingHooks).toEqual([]);
    expect(h.logs.some((l) => l.includes('given up after 5 attempts'))).toBe(true);
  });

  it('a retried hook succeeds and is removed', async () => {
    const h = await makeHarness();
    h.failHooks.remaining = 1;
    const order = await awaitingApproval(h);
    await h.service.drainHooks();
    await h.service.reconcile();
    await h.service.drainHooks();
    expect(h.store.getOrder(order.id)?.pendingHooks).toEqual([]);
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onApprovalNeeded']);
  });

  it('a stale onApprovalNeeded (already decided) is dropped without asking the owner', async () => {
    const h = await makeHarness();
    h.failHooks.remaining = 1;
    const order = await awaitingApproval(h);
    await h.service.drainHooks();
    ok(await h.service.approve(order.id));
    await h.service.drainHooks();
    await h.service.reconcile();
    await h.service.drainHooks();
    expect(h.hookCalls.map((c) => c.hook)).toEqual(['onPaid']);
  });
});

describe('public projection', () => {
  it('toPublic carries no buyer PII and no answers', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    const pub = h.service.toPublic(order);
    const text = JSON.stringify(pub);
    expect(text).not.toContain(BUYER.email);
    expect(text).not.toContain(BUYER.name);
    expect(text).not.toContain('participants');
    expect(pub).toMatchObject({ id: order.id, status: 'awaiting_approval', statusUrl: `https://book.example.com/orders/${order.id}` });
  });

  it('lists orders newest first and filters by status', async () => {
    const h = await makeHarness();
    const a = await awaitingApproval(h);
    h.clock.advance(MIN);
    const b = await awaitingApproval(h);
    ok(await h.service.approve(b.id));
    expect((await h.service.listOrders()).map((o) => o.id)).toEqual([b.id, a.id]);
    expect((await h.service.listOrders({ status: 'paid' })).map((o) => o.id)).toEqual([b.id]);
    expect(await h.service.getLiveOrderForQuote(a.quoteId)).toMatchObject({ id: a.id });
  });
});

describe('quote consumption after the owner decides', () => {
  async function refusedEverywhere(h: Harness, quoteId: string): Promise<void> {
    expect(h.store.getQuote(quoteId)?.expiresAt).toBe(h.clock.now.toISOString());
    expect(await pay(h, quoteId, { spt: 'spt_retry_card' })).toMatchObject({ ok: false, error: 'quote_expired' });
    expect(await pay(h, quoteId, { door: 'acp', spt: 'spt_retry_card' })).toMatchObject({ ok: false, error: 'quote_expired' });
    expect(await h.service.startLinkOrder(quoteId)).toMatchObject({ ok: false, error: 'quote_expired' });
    expect(h.store.ordersForQuote(quoteId)).toHaveLength(1);
  }

  it('rejected: the quote is consumed in the same write; the buyer must re-scope', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    h.clock.advance(MIN);
    ok(await h.service.reject(order.id, 'Fully booked'));
    const persisted = JSON.parse(h.backend.text ?? '{}') as { quotes: Record<string, { expiresAt: string }> };
    expect(persisted.quotes[order.quoteId]?.expiresAt).toBe(h.clock.now.toISOString());
    await refusedEverywhere(h, order.quoteId);
  });

  it('expired after awaiting approval (deadline sweep, late approve, lapsed hold) consumes the quote', async () => {
    // 1h approval window with a 4h quote TTL: the quote is still live (and unpruned) when the deadline passes.
    const swept = await makeHarness({ config: { approvalWindowHours: 1, quoteTtlMinutes: 240 } });
    const a = await awaitingApproval(swept);
    swept.clock.advance(HOUR);
    await swept.service.reconcile();
    expect(swept.store.getOrder(a.id)?.status).toBe('expired');
    await refusedEverywhere(swept, a.quoteId);

    const late = await makeHarness({ config: { approvalWindowHours: 1, quoteTtlMinutes: 240 } });
    const b = await awaitingApproval(late);
    late.clock.advance(HOUR);
    expect(ok(await late.service.approve(b.id)).status).toBe('expired');
    await refusedEverywhere(late, b.quoteId);

    const lapsed = await makeHarness({ config: { quoteTtlMinutes: 240 } });
    const c = await awaitingApproval(lapsed);
    lapsed.clock.advance(10 * MIN);
    lapsed.gateway.setIntent(c.stripe.paymentIntentId ?? '', { status: 'canceled' });
    await lapsed.service.handleStripeTrigger({ type: 'payment_intent.canceled', objectId: c.stripe.paymentIntentId ?? '', metadata: { orderId: c.id } });
    expect(lapsed.store.getOrder(c.id)?.status).toBe('expired');
    await refusedEverywhere(lapsed, c.quoteId);
  });

  it('payment_failed and buyer-canceled orders still free the quote (≤ 3 orders)', async () => {
    const h = await makeHarness({ config: { quoteTtlMinutes: 240 } });
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', new DefinitiveGatewayError('Your card was declined.', 'card_declined'));
    expect(ok(await pay(h, quote.id, { spt: 'spt_one' })).status).toBe('payment_failed');
    const second = ok(await pay(h, quote.id, { spt: 'spt_two' }));
    expect(second.status).toBe('awaiting_approval');
    h.clock.advance(MIN);
    expect(ok(await h.service.cancel(second.id)).status).toBe('canceled');
    expect(Date.parse(h.store.getQuote(quote.id)?.expiresAt ?? '')).toBeGreaterThan(h.clock.now.getTime());
    expect(ok(await pay(h, quote.id, { spt: 'spt_three' })).status).toBe('awaiting_approval');
    expect(h.store.ordersForQuote(quote.id)).toHaveLength(3);
  });
});

describe('requireSettled never says "declined" while the outcome is unknown', () => {
  const settle = (h: Harness, quoteId: string, spt = SPT) =>
    h.service.payWithSpt({ quoteId, door: 'mpp', spt, requireSettled: true });

  it('an ambiguous PI create is payment_pending; the same-SPT retry resumes the order (same key, one PI) and settles', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    const first = await settle(h, quote.id);
    expect(first).toMatchObject({ ok: false, error: 'payment_pending' });
    expect(first.ok ? '' : first.message).not.toMatch(/not charged|nothing was charged/i);
    const [order] = h.store.ordersForQuote(quote.id);
    expect(order).toMatchObject({ status: 'authorizing' });

    const retry = ok(await settle(h, quote.id));
    expect(retry).toMatchObject({ id: order?.id, status: 'paid' });
    const calls = h.gateway.callsOf('authorizeSpt');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args['fingerprint']).toBe(calls[1]?.args['fingerprint']);
    expect(h.gateway.intents.size).toBe(1);
    expect(h.store.ordersForQuote(quote.id)).toHaveLength(1);
  });

  it('an unobservable outcome (create lost, PI never seen) stays pending, never declined', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous');
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_pending' });
    h.gateway.failNext('authorizeSpt', 'ambiguous');
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_pending' });
    expect(ok(await settle(h, quote.id)).status).toBe('paid');
    expect(h.gateway.intents.size).toBe(1);
  });

  it('a hold that did not settle is voided to canceled (not_settled); a PI surfacing later is released, never captured', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('capture', new DefinitiveGatewayError('capture refused', 'payment_intent_unexpected_state'));
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_declined' });
    const [order] = h.store.ordersForQuote(quote.id);
    expect(order).toMatchObject({ status: 'canceled', voidOutcome: 'canceled', statusReason: 'not_settled' });
    expect(h.gateway.intents.get(order?.stripe.paymentIntentId ?? '')?.status).toBe('canceled');

    // A second PI for the dead order turns up (e.g. a replayed create): voided by webhook and sweep, never captured.
    const late = h.gateway.addIntent({ status: 'requires_capture', amount: 14600, currency: 'usd', metadata: { orderId: order?.id ?? '' }, amountRefunded: 0 });
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: late.id, metadata: { orderId: order?.id ?? '' } });
    h.clock.advance(3 * MIN);
    await h.service.reconcile();
    expect(h.gateway.intents.get(late.id)?.status).toBe('canceled');
    expect(h.gateway.callsOf('capture').filter((c) => c.args['paymentIntentId'] === late.id)).toHaveLength(0);
    expect(h.store.getOrder(order?.id ?? '')?.status).toBe('canceled');
  });

  it('a void whose cancel is ambiguous is pending; the retry finishes the void and only then declines', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('capture', new DefinitiveGatewayError('capture refused', 'payment_intent_unexpected_state'));
    h.gateway.failNext('cancel', 'ambiguous', 2);
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_pending' });
    expect(h.store.ordersForQuote(quote.id)[0]).toMatchObject({ status: 'voiding', voidOutcome: 'canceled' });
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_declined' });
    expect(h.store.ordersForQuote(quote.id)).toHaveLength(1);
  });

  it('a capture that landed despite an ambiguous error is reported paid on the retry', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('capture', 'ambiguous_after');
    h.gateway.failNext('retrievePaymentIntent', 'ambiguous', 2);
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_pending' });
    expect(ok(await settle(h, quote.id)).status).toBe('paid');
    expect(h.gateway.callsOf('cancel')).toHaveLength(0);
  });

  it('re-check: an MPP hold found by the sweep (client never retried) is voided, never captured', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    expect(await settle(h, quote.id)).toMatchObject({ ok: false, error: 'payment_pending' });
    const [order] = h.store.ordersForQuote(quote.id);
    // The agent gives up; the sweep later finds the hold by metadata.
    h.clock.advance(3 * MIN);
    await h.service.reconcile();
    const after = h.store.getOrder(order?.id ?? '');
    expect(after).toMatchObject({ status: 'canceled', voidOutcome: 'canceled', statusReason: 'not_settled' });
    expect(h.gateway.callsOf('capture')).toHaveLength(0);
    expect(h.gateway.intents.get(after?.stripe.paymentIntentId ?? '')?.status).toBe('canceled');
  });

  it('re-check: an MPP hold webhook within the 2-min grace is left for the retry; after it, voided', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const q0 = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    expect(await settle(h, q0.id)).toMatchObject({ ok: false, error: 'payment_pending' });
    const [early] = h.store.ordersForQuote(q0.id);
    const [earlyPi] = h.gateway.intents.values();
    // The hold webhook typically lands seconds later, before the client's retry: no void.
    h.clock.advance(2 * MIN - 1);
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: earlyPi?.id ?? '', metadata: { orderId: early?.id ?? '' } });
    expect(h.store.getOrder(early?.id ?? '')?.status).toBe('authorizing');
    expect(h.gateway.intents.get(earlyPi?.id ?? '')?.status).toBe('requires_capture');
    expect(h.gateway.callsOf('cancel')).toHaveLength(0);
    // The retry with the same token then finishes the same order.
    expect(ok(await settle(h, q0.id))).toMatchObject({ id: early?.id, status: 'paid' });

    const q1 = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    expect(await settle(h, q1.id, 'spt_first')).toMatchObject({ ok: false, error: 'payment_pending' });
    const [a] = h.store.ordersForQuote(q1.id);
    const pi = [...h.gateway.intents.values()].find((p) => p.metadata['orderId'] === a?.id);
    // The client never retried: once the grace is over, the webhook voids the hold.
    h.clock.advance(2 * MIN);
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: pi?.id ?? '', metadata: { orderId: a?.id ?? '' } });
    expect(h.store.getOrder(a?.id ?? '')).toMatchObject({ status: 'canceled', statusReason: 'not_settled' });
    expect(h.gateway.callsOf('capture').filter((c) => c.args['paymentIntentId'] === pi?.id)).toHaveLength(0);

    // Crash mid-capture (order left capturing, PI still held): the sweep voids instead of re-capturing.
    const q2 = await h.quote();
    h.gateway.failNext('capture', 'ambiguous');
    h.gateway.failNext('retrievePaymentIntent', 'ambiguous', 2);
    expect(await settle(h, q2.id, 'spt_second')).toMatchObject({ ok: false, error: 'payment_pending' });
    const [b] = h.store.ordersForQuote(q2.id);
    expect(b?.status).toBe('capturing');
    h.clock.advance(3 * MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(b?.id ?? '')).toMatchObject({ status: 'canceled', statusReason: 'not_settled' });
    expect(h.gateway.callsOf('capture').filter((c) => c.args['paymentIntentId'] === b?.stripe.paymentIntentId)).toHaveLength(1);
  });

  it('non-MPP instant orders are still captured by the sweep (UCP/ACP report authorizing as in progress)', async () => {
    const h = await makeHarness({ config: { confirmation: 'instant' } });
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous_after');
    const order = ok(await pay(h, quote.id));
    h.clock.advance(3 * MIN);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)?.status).toBe('paid');
  });

  it('the live order is found before the stored quote (resume after the quote is pruned)', async () => {
    const h = await makeHarness();
    const quote = await h.quote();
    h.gateway.failNext('authorizeSpt', 'ambiguous');
    const first = ok(await pay(h, quote.id));
    expect(first.status).toBe('authorizing');
    h.clock.advance(3 * HOUR);
    await h.store.prune(h.clock.now);
    expect(h.store.getQuote(quote.id)).toBeUndefined();
    const resumed = ok(await pay(h, quote.id));
    expect(resumed).toMatchObject({ id: first.id, status: 'awaiting_approval' });

    const link = await h.quote();
    const started = ok(await h.service.startLinkOrder(link.id));
    h.clock.advance(15 * MIN);
    await h.store.prune(new Date(h.clock.now.getTime() + 2 * HOUR));
    expect(h.store.getQuote(link.id)).toBeUndefined();
    expect(ok(await h.service.startLinkOrder(link.id)).url).toBe(started.url);
  });
});

describe('releases of money a dead or stray order must not keep are retried until resolved', () => {
  async function capturedLinkOrderFailingRecheck(h: Harness): Promise<{ orderId: string; piId: string }> {
    const quote = await h.quote();
    const { order } = ok(await h.service.startLinkOrder(quote.id));
    const pi = h.gateway.payCheckoutSession(h.store.getOrder(order.id)?.stripe.checkoutSessionId ?? '', { status: 'succeeded' });
    h.facts['tide'] = 'high';
    return { orderId: order.id, piId: pi.id };
  }

  it('an ambiguous refund: the webhook fails (500 → Stripe redelivers), the sweep retries, the marker clears', async () => {
    const h = await makeHarness();
    const { orderId, piId } = await capturedLinkOrderFailingRecheck(h);
    h.gateway.failNext('refund', 'ambiguous', 2);
    const trigger = () => h.service.handleStripeTrigger({ type: 'payment_intent.succeeded', objectId: piId, metadata: { orderId } });
    await expect(trigger()).rejects.toThrow(/unresolved/);
    // Tracked before the call; webhook attempts never count toward the cap.
    expect(h.store.getOrder(orderId)).toMatchObject({ status: 'canceled', statusReason: 'discrepancy', releases: [{ paymentIntentId: piId, attempts: 0 }] });
    expect(h.gateway.intents.get(piId)?.amountRefunded).toBe(0);

    // The sweep retries even though the order is terminal; its failure counts and backs off 1 min.
    await h.service.reconcile();
    expect(h.gateway.callsOf('refund')).toHaveLength(2);
    expect(h.store.getOrder(orderId)?.releases).toEqual([expect.objectContaining({ attempts: 1 })]);
    h.clock.advance(MIN);
    await h.service.reconcile();
    expect(h.gateway.intents.get(piId)?.amountRefunded).toBe(14600);
    expect(h.store.getOrder(orderId)?.releases).toBeUndefined();
    // Redelivered webhook now succeeds; the flagged order is never pruned.
    await trigger();
    h.clock.advance(100 * 24 * HOUR);
    await h.service.reconcile();
    expect(h.store.getOrder(orderId)).toMatchObject({ statusReason: 'discrepancy' });
  });

  it('redelivered webhooks during backoff skip the release (still 500) and never burn the attempt cap', async () => {
    const h = await makeHarness();
    const { orderId, piId } = await capturedLinkOrderFailingRecheck(h);
    h.gateway.failNext('refund', 'ambiguous', 2);
    const trigger = () => h.service.handleStripeTrigger({ type: 'payment_intent.succeeded', objectId: piId, metadata: { orderId } });
    await expect(trigger()).rejects.toThrow(/unresolved/);
    await h.service.reconcile(); // counted attempt 1, next try in 1 min
    const refunds = h.gateway.callsOf('refund').length;
    for (let i = 0; i < 3 * MAX_RELEASE_ATTEMPTS; i++) await expect(trigger()).rejects.toThrow(/unresolved/);
    expect(h.gateway.callsOf('refund')).toHaveLength(refunds);
    expect(h.store.getOrder(orderId)?.releases).toEqual([expect.objectContaining({ attempts: 1 })]);
    h.clock.advance(MIN);
    await trigger(); // due again: the webhook may act, and this time Stripe answers
    expect(h.gateway.intents.get(piId)?.amountRefunded).toBe(14600);
    expect(h.store.getOrder(orderId)?.releases).toBeUndefined();
  });

  it('a stray hold whose cancel keeps failing backs off, then is given up loudly with the record kept', async () => {
    const h = await makeHarness();
    const order = await awaitingApproval(h);
    ok(await h.service.reject(order.id));
    const stray = h.gateway.addIntent({ status: 'requires_capture', amount: 14600, currency: 'usd', metadata: { orderId: order.id }, amountRefunded: 0 });
    h.gateway.failNext('cancel', 'ambiguous', 100);
    await expect(h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: stray.id, metadata: { orderId: order.id } }))
      .rejects.toThrow(/unresolved/);
    for (let i = 0; i < 40 && (h.store.getOrder(order.id)?.releases?.[0]?.attempts ?? 0) < MAX_RELEASE_ATTEMPTS; i++) {
      h.clock.advance(HOUR);
      await h.service.reconcile();
    }
    const after = h.store.getOrder(order.id);
    expect(after?.releases).toEqual([expect.objectContaining({ paymentIntentId: stray.id, attempts: MAX_RELEASE_ATTEMPTS })]);
    expect(h.logs.some((l) => l.includes('RELEASE GIVEN UP') && l.includes(stray.id))).toBe(true);
    const cancels = h.gateway.callsOf('cancel').length;
    h.clock.advance(HOUR);
    await h.service.reconcile();
    expect(h.gateway.callsOf('cancel')).toHaveLength(cancels);
    // Given up: the webhook stops asking Stripe to redeliver.
    await h.service.handleStripeTrigger({ type: 'payment_intent.amount_capturable_updated', objectId: stray.id, metadata: { orderId: order.id } });
    h.clock.advance(100 * 24 * HOUR);
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)).toBeDefined();
  });
});

describe('hooks cannot hold the reconciler hostage', () => {
  it('a hung hook times out as a failed attempt; reconcile never waits for it', async () => {
    const h = await makeHarness({ hookTimeoutMs: 30 });
    h.hangHooks.on = true;
    const order = await awaitingApproval(h);
    h.clock.advance(24 * HOUR);
    // The onApprovalNeeded call hangs, yet the deadline sweep runs and voids the hold.
    await h.service.reconcile();
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'expired' });
    await h.service.drainHooks();
    expect(h.logs.some((l) => l.includes('timed out after 30ms'))).toBe(true);
    expect(h.store.getOrder(order.id)?.pendingHooks).toContainEqual({ hook: 'onApprovalNeeded', attempts: 1 });
    h.hangHooks.on = false;
    await h.service.reconcile();
    await h.service.drainHooks();
    expect(h.store.getOrder(order.id)?.pendingHooks).toEqual([]);
    expect(h.hookCalls.map((c) => c.hook)).toContain('onClosed');
  });
});

describe('quotes live in memory until an order starts; two-decimal currencies only', () => {
  it('scoping writes nothing to disk; a restart forgets unstarted quotes (buyer re-scopes)', async () => {
    const h = await makeHarness();
    const saves = h.backend.saves;
    const quote = await h.quote();
    expect(h.backend.saves).toBe(saves);
    const restarted = await h.restart();
    expect(await restarted.service.payWithSpt({ quoteId: quote.id, door: 'ucp', spt: SPT, buyer: BUYER })).toMatchObject({ ok: false, error: 'quote_not_found' });
  });

  it('quote flood: at the cap, new quotes are not payable (logged once a minute); live quotes survive', async () => {
    const h = await makeHarness();
    const real = await h.quote();
    const live = new Date(h.clock.now.getTime() + HOUR).toISOString();
    for (let i = 1; i < MAX_MEMORY_QUOTES; i++) {
      h.store.rememberQuote({ ...real, id: `qt_flood${String(i)}`, expiresAt: live }, h.clock.now);
    }
    const request = { answers: { participants: 2 }, selections: {} };
    expect(await h.service.createQuote('lesson', request, real.quote)).toBeUndefined();
    expect(await h.service.createQuote('lesson', request, real.quote)).toBeUndefined();
    expect(h.logs.filter((l) => l.includes('quote store full'))).toHaveLength(1);
    h.clock.advance(MIN);
    expect(await h.service.createQuote('lesson', request, real.quote)).toBeUndefined();
    expect(h.logs.filter((l) => l.includes('quote store full'))).toHaveLength(2);
    // The real buyer's quote was never evicted.
    expect(ok(await pay(h, real.id)).status).toBe('awaiting_approval');
  });

  /** Distinct (never deduplicated) requests; only `variant(0)` re-evaluates to the real price. */
  const variant = (i: number): ScopedRequest => ({ answers: i === 0 ? { participants: 2 } : { participants: 2, round: i }, selections: {} });

  it(`one client holds at most ${MAX_UNPAID_PER_CLIENT} unpaid quotes; others are unaffected; a held payment or expiry frees the quota`, async () => {
    const h = await makeHarness();
    const real = await h.quote();
    const flooder = '203.0.113.7\u001b[2J';
    const held: string[] = [];
    for (let i = 0; i < MAX_UNPAID_PER_CLIENT; i++) {
      const stored = await h.service.createQuote('lesson', variant(i), real.quote, flooder);
      if (stored === undefined) throw new Error(`quote ${String(i)} refused under the quota`);
      held.push(stored.id);
    }
    expect(await h.service.createQuote('lesson', variant(1000), real.quote, flooder)).toBeUndefined();
    expect(await h.service.createQuote('lesson', variant(1001), real.quote, flooder)).toBeUndefined();
    const quotaLogs = h.logs.filter((l) => l.includes('unpaid quotes'));
    expect(quotaLogs).toHaveLength(1); // throttled
    expect(quotaLogs[0]).toContain('client 203.0.113.7[2J holds');
    expect(quotaLogs[0]).not.toContain('\u001b');
    // Another client, and callers without a client key, still get payable quotes.
    expect(await h.service.createQuote('lesson', variant(2000), real.quote, '198.51.100.1')).toBeDefined();
    expect(await h.service.createQuote('lesson', variant(2001), real.quote)).toBeDefined();
    // A real card hold on one of the flooder's quotes frees one slot.
    ok(await pay(h, held[0]!));
    expect(await h.service.createQuote('lesson', variant(1002), real.quote, flooder)).toBeDefined();
    expect(await h.service.createQuote('lesson', variant(1003), real.quote, flooder)).toBeUndefined();
    // Once its quotes expire, the client is welcome again.
    h.clock.advance(31 * MIN);
    expect(await h.service.createQuote('lesson', variant(1004), real.quote, flooder)).toBeDefined();
  });

  it('the global memory cap stays the backstop for a client under its own quota', async () => {
    const h = await makeHarness();
    const real = await h.quote();
    const live = new Date(h.clock.now.getTime() + HOUR).toISOString();
    for (let i = 1; i < MAX_MEMORY_QUOTES; i++) {
      h.store.rememberQuote({ ...real, id: `qt_flood${String(i)}`, expiresAt: live, client: `10.0.${String(i % 250)}.${String(i % 199)}` }, h.clock.now);
    }
    expect(await h.service.createQuote('lesson', variant(1), real.quote, '192.0.2.10')).toBeUndefined();
    expect(h.logs.some((l) => l.includes('quote store full'))).toBe(true);
  });

  it(`100 rounds of scope → payment link from one client create at most ${MAX_UNPAID_PER_CLIENT} orders`, async () => {
    const h = await makeHarness();
    const real = await h.quote();
    const flooder = '203.0.113.9';
    let linked = 0;
    for (let round = 0; round < 100; round++) {
      const stored = await h.service.createQuote('lesson', variant(0), real.quote, flooder);
      if (stored === undefined) continue;
      ok(await h.service.startLinkOrder(stored.id));
      linked += 1;
    }
    expect(linked).toBe(MAX_UNPAID_PER_CLIENT);
    const orders = (await h.service.listOrders()).filter((order) => order.client === flooder);
    expect(orders).toHaveLength(MAX_UNPAID_PER_CLIENT);
    expect(orders.every((order) => order.door === 'link' && order.status === 'awaiting_payment')).toBe(true);
    // Other clients are unaffected.
    expect(await h.service.createQuote('lesson', variant(0), real.quote, '198.51.100.2')).toBeDefined();
  });

  it('junk payment tokens count against the client too (payment_failed orders)', async () => {
    const h = await makeHarness();
    const real = await h.quote();
    const flooder = '203.0.113.10';
    let failed = 0;
    for (let round = 0; round < 100; round++) {
      const stored = await h.service.createQuote('lesson', variant(0), real.quote, flooder);
      if (stored === undefined) continue;
      h.gateway.failNext('authorizeSpt', new DefinitiveGatewayError('Your card was declined.', 'card_declined'));
      const result = await pay(h, stored.id);
      if (!result.ok || result.value.status === 'payment_failed') failed += 1;
    }
    const orders = (await h.service.listOrders()).filter((order) => order.client === flooder);
    expect(failed).toBe(MAX_UNPAID_PER_CLIENT);
    expect(orders).toHaveLength(MAX_UNPAID_PER_CLIENT);
    expect(orders.every((order) => order.status === 'payment_failed')).toBe(true);
  });

  /** A harness whose store already holds `count` open unpaid orders on `door` (in `status`). */
  async function seededHarness(count: number, door: Order['door'], status: 'awaiting_payment' | 'authorizing') {
    const seed = await makeHarness();
    const real = await seed.quote();
    ok(await seed.service.startLinkOrder(real.id));
    const stored = (await seed.service.listOrders())[0]!;
    const orders: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      const id = `ord_${i.toString(2).padStart(24, 'a').replaceAll('0', 'a').replaceAll('1', 'b')}`;
      orders[id] = { ...stored, id, door, status, quoteId: `qt_${id.slice(4)}`, stripe: {} };
    }
    const backend = new MemoryBackend();
    backend.text = JSON.stringify({ schema: 1, quotes: {}, orders, nonces: {}, collections: {} });
    return { h: await makeHarness({ backend }), backend };
  }

  it(`at ${MAX_OPEN_UNPAID_ORDERS_PER_DOOR} open unpaid link orders the link door refuses; the token doors stay open`, async () => {
    const { h, backend } = await seededHarness(MAX_OPEN_UNPAID_ORDERS_PER_DOOR, 'link', 'awaiting_payment');
    const fresh = await h.quote();
    expect(await h.service.startLinkOrder(fresh.id)).toMatchObject({ ok: false, error: 'door_unavailable' });
    expect(await h.service.startLinkOrder(fresh.id)).toMatchObject({ ok: false, error: 'door_unavailable' });
    expect(h.logs.filter((l) => l.includes('unpaid link orders are open'))).toHaveLength(1);
    expect(backend.saves).toBe(0);
    expect(ok(await pay(h, fresh.id)).status).toBe('awaiting_approval');
  });

  it(`at ${MAX_OPEN_UNPAID_ORDERS_PER_DOOR} open unpaid UCP orders UCP refuses; ACP and the link door stay open`, async () => {
    const { h } = await seededHarness(MAX_OPEN_UNPAID_ORDERS_PER_DOOR, 'ucp', 'authorizing');
    const fresh = await h.quote();
    expect(await pay(h, fresh.id)).toMatchObject({ ok: false, error: 'door_unavailable' });
    expect(ok(await pay(h, fresh.id, { door: 'acp' })).status).toBe('awaiting_approval');
    ok(await h.service.startLinkOrder((await h.quote()).id));
  });

  it('concurrent orders on different quotes never overshoot the per-door cap', async () => {
    const { h } = await seededHarness(MAX_OPEN_UNPAID_ORDERS_PER_DOOR - 1, 'link', 'awaiting_payment');
    const quotes = [await h.quote(), await h.quote(), await h.quote()];
    const results = await Promise.all(quotes.map((quote) => h.service.startLinkOrder(quote.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === 'door_unavailable')).toHaveLength(2);
    const open = (await h.service.listOrders()).filter((order) => order.door === 'link' && order.status === 'awaiting_payment');
    expect(open).toHaveLength(MAX_OPEN_UNPAID_ORDERS_PER_DOOR);
  });

  it('client keys map to their network: IPv6 /64 keys to the /48; IPv4 addresses have none', () => {
    expect(clientNetwork('2001:db8:7:1::/64')).toBe('2001:db8:7::/48');
    expect(clientNetwork('2001:db8:7:ffff::/64')).toBe('2001:db8:7::/48');
    expect(clientNetwork('203.0.113.7')).toBeUndefined();
    expect(clientNetwork('unknown')).toBeUndefined();
    expect(clientNetwork('203.0.113.7\u001b[2J')).toBeUndefined();
  });

  it(`one IPv6 /48 holds at most ${MAX_UNPAID_PER_NETWORK} unpaid quotes however many /64s it rotates through`, async () => {
    const h = await makeHarness();
    const real = await h.quote();
    let round = 0;
    const fill = async (client: string): Promise<number> => {
      let held = 0;
      for (let i = 0; i < MAX_UNPAID_PER_CLIENT; i++) {
        if (await h.service.createQuote('lesson', variant(++round), real.quote, client) !== undefined) held += 1;
      }
      return held;
    };
    const perClient: number[] = [];
    for (let n = 1; n <= MAX_UNPAID_PER_NETWORK / MAX_UNPAID_PER_CLIENT; n++) perClient.push(await fill(`2001:db8:7:${n.toString(16)}::/64`));
    expect(perClient).toEqual(Array<number>(MAX_UNPAID_PER_NETWORK / MAX_UNPAID_PER_CLIENT).fill(MAX_UNPAID_PER_CLIENT));
    // A fresh /64 in the same /48 gets nothing; another /48 is unaffected.
    expect(await h.service.createQuote('lesson', variant(++round), real.quote, '2001:db8:7:99::/64')).toBeUndefined();
    expect(h.logs.some((l) => l.includes(`network 2001:db8:7::/48 holds ${String(MAX_UNPAID_PER_NETWORK)} unpaid`))).toBe(true);
    expect(await h.service.createQuote('lesson', variant(++round), real.quote, '2001:db8:8:1::/64')).toBeDefined();
    // Once the network's quotes expire it is welcome again.
    h.clock.advance(31 * MIN);
    expect(await h.service.createQuote('lesson', variant(++round), real.quote, '2001:db8:7:99::/64')).toBeDefined();
  });

  it('IPv4 addresses sharing a range (agent platforms, carrier NAT) have no network quota, only the per-client one', async () => {
    const h = await makeHarness();
    const real = await h.quote();
    let round = 0;
    for (let n = 1; n <= MAX_UNPAID_PER_NETWORK / MAX_UNPAID_PER_CLIENT; n++) {
      for (let i = 0; i < MAX_UNPAID_PER_CLIENT; i++) {
        expect(await h.service.createQuote('lesson', variant(++round), real.quote, `198.51.100.${String(n)}`)).toBeDefined();
      }
    }
    expect(await h.service.createQuote('lesson', variant(++round), real.quote, '198.51.100.200')).toBeDefined();
  });

  it('the same client asking again for the same request and price gets its live quote back', async () => {
    const h = await makeHarness();
    const real = await h.quote();
    const client = '203.0.113.11';
    const first = await h.service.createQuote('lesson', variant(0), real.quote, client);
    expect(first).toBeDefined();
    expect((await h.service.createQuote('lesson', variant(0), real.quote, client))?.id).toBe(first?.id);
    // A different client, request or price mints its own quote.
    expect((await h.service.createQuote('lesson', variant(0), real.quote, '198.51.100.3'))?.id).not.toBe(first?.id);
    expect((await h.service.createQuote('lesson', variant(1), real.quote, client))?.id).not.toBe(first?.id);
    expect((await h.service.createQuote('lesson', variant(0), { ...real.quote, totalCents: real.quote.totalCents + 100 }, client))?.id).not.toBe(first?.id);
    // Past half its lifetime the old quote is not handed out again.
    h.clock.advance(16 * MIN);
    const later = await h.service.createQuote('lesson', variant(0), real.quote, client);
    expect(later?.id).not.toBe(first?.id);
    // A started quote is never handed out again.
    ok(await h.service.startLinkOrder(later!.id));
    expect((await h.service.createQuote('lesson', variant(0), real.quote, client))?.id).not.toBe(later?.id);
  });

  it('createQuote refuses a non-two-decimal currency and totals under Stripe\'s minimum for the currency', async () => {
    const h = await makeHarness();
    const base = { lines: [], subtotalCents: 10_000, taxCents: 0, totalCents: 10_000 };
    const request = { answers: {}, selections: {} };
    expect(await h.service.createQuote('lesson', request, { ...base, currency: 'JPY' })).toBeUndefined();
    expect(h.logs.some((l) => l.includes('JPY is not a two-decimal currency'))).toBe(true);
    expect(await h.service.createQuote('lesson', request, { ...base, currency: 'HKD', totalCents: 399 })).toBeUndefined();
    expect(await h.service.createQuote('lesson', request, { ...base, currency: 'HKD', totalCents: 400 })).toBeDefined();
    expect(await h.service.createQuote('lesson', request, { ...base, currency: 'GBP', totalCents: 30 })).toBeDefined();
    expect(await h.service.createQuote('lesson', request, { ...base, currency: 'XYZ', totalCents: 49 })).toBeUndefined();
  });
});
