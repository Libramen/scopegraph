/**
 * `createCheckoutService`: admission (nothing stored without a live
 * quote; per-quote and global caps; early prune), buyer hygiene, quote validation, derived status,
 * complete/cancel semantics, attempt cap, freeze while an order is live, door isolation,
 * bearer binding (ACP), pending-payment recovery and ACP order-event state.
 */
import { describe, expect, it } from 'vitest';
import {
  createCheckoutService,
  MAX_CHECKOUTS_PER_QUOTE,
  MAX_COMPLETE_ATTEMPTS,
  MAX_OPEN_ACP_CHECKOUTS_PER_BEARER,
  MAX_OPEN_UCP_CHECKOUTS,
} from './index.js';
import { checkoutView, doorDeps, storedQuote, testQuoteId, type TestDoorDeps } from '../testing.js';
import { graph } from '../../engine/testing.js';
import { MemoryBackend, PaymentsStore } from '../store/index.js';
import type { Order } from '../types.js';

const SPT = 'spt_test_redacted';
const NOW = new Date('2026-11-20T12:00:00Z');

async function setup(overrides: { config?: TestDoorDeps['config'] } = {}) {
  const deps = await doorDeps({ now: () => NOW, ...overrides });
  const quote = storedQuote(testQuoteId('ready'), NOW);
  deps.service.quotes.set(quote.id, quote);
  return { deps, checkout: createCheckoutService(deps), quote };
}

const checkoutCreate = async (deps: TestDoorDeps, itemId: string, buyer?: { email?: string }) => {
  const checkout = createCheckoutService(deps);
  return checkoutView(await checkout.create('ucp', { lineItems: [{ id: itemId, quantity: 1 }], buyer }));
};

describe('createCheckoutService', () => {
  it('non-quote, malformed or unknown item id → refused with recoverable quote_required, nothing stored', async () => {
    const { checkout } = await setup();
    for (const itemId of ['surf-lesson', 'x'.repeat(3000), 'qt_short', testQuoteId('unknown')]) {
      const result = await checkout.create('ucp', { lineItems: [{ id: itemId, quantity: 1 }], buyer: { email: 'buyer@example.com' } });
      expect(result).toMatchObject({ ok: false, reason: 'invalid_items', message: { type: 'error', code: 'quote_required', severity: 'recoverable', field: 'quote' } });
    }
    // Ten junk items: refused as a malformed checkout, not stored either.
    const many = await checkout.create('ucp', { lineItems: Array.from({ length: 10 }, () => ({ id: 'x'.repeat(3000), quantity: 1 })) });
    expect(many).toMatchObject({ ok: false, reason: 'invalid_items', message: { code: 'invalid_line_items' } });
    expect(await checkout.create('ucp', { lineItems: [] })).toMatchObject({ ok: false, reason: 'invalid_items' });
    expect(checkout.list('ucp')).toHaveLength(0);
  });

  it('expired quote → refused with quote_expired, nothing stored', async () => {
    const { deps, checkout } = await setup();
    const stale = storedQuote(testQuoteId('stale'), NOW, undefined);
    stale.expiresAt = new Date(NOW.getTime() - 60_000).toISOString();
    deps.service.quotes.set(stale.id, stale);
    const result = await checkout.create('ucp', { lineItems: [{ id: stale.id, quantity: 1 }] });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_items', message: { code: 'quote_expired', severity: 'recoverable', field: 'quote' } });
    expect(checkout.list('ucp')).toHaveLength(0);
  });

  it('an update to an unusable item is refused and leaves the checkout unchanged', async () => {
    const { deps, quote, checkout } = await setup();
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const refused = await checkout.update('ucp', created.id, { lineItems: [{ id: 'y'.repeat(3000), quantity: 1 }], buyer: { name: 'z'.repeat(3000) } });
    expect(refused).toMatchObject({ ok: false, reason: 'invalid_items', message: { code: 'quote_required' } });
    const after = await checkout.get('ucp', created.id);
    expect(after?.status).toBe('ready_for_complete');
    expect(after?.lineItems[0]?.itemId).toBe(quote.id);
    expect(after?.buyer).toEqual({ email: 'buyer@example.com' });
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it(`at most ${MAX_CHECKOUTS_PER_QUOTE} checkouts per quote (canceled ones count); moving onto a full quote is refused`, async () => {
    const { deps, quote, checkout } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_CHECKOUTS_PER_QUOTE; i++) ids.push((await checkoutCreate(deps, quote.id)).id);
    await checkout.cancel('ucp', ids[0]!);
    const extra = await checkout.create('ucp', { lineItems: [{ id: quote.id, quantity: 1 }] });
    expect(extra).toMatchObject({ ok: false, reason: 'quote_busy', message: { code: 'too_many_checkouts', field: 'quote' } });
    expect(checkout.list('ucp')).toHaveLength(MAX_CHECKOUTS_PER_QUOTE);

    const other = storedQuote(testQuoteId('other'), NOW);
    deps.service.quotes.set(other.id, other);
    const elsewhere = await checkoutCreate(deps, other.id);
    const moved = await checkout.update('ucp', elsewhere.id, { lineItems: [{ id: quote.id, quantity: 1 }] });
    expect(moved).toMatchObject({ ok: false, reason: 'quote_busy' });
    expect((await checkout.get('ucp', elsewhere.id))?.lineItems[0]?.itemId).toBe(other.id);
    // Updating a checkout already on the quote is not "another" checkout.
    expect(checkoutView(await checkout.update('ucp', ids[1]!, { buyer: { email: 'b@example.com' } })).status).toBe('ready_for_complete');
  });

  /** A store preloaded with `count` open (never-paid) checkouts of one door/bearer. */
  async function storeWithOpenCheckouts(count: number, door: 'ucp' | 'acp', principal?: string): Promise<{ deps: TestDoorDeps; backend: MemoryBackend }> {
    const base = await doorDeps({ now: () => NOW });
    const records: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      const id = `chk_${i.toString(2).padStart(24, 'a').replaceAll('0', 'a').replaceAll('1', 'b')}`;
      records[id] = { id, door, ...(principal ? { principal } : {}), lineItems: [], attempts: 0, canceled: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), version: 0 };
    }
    const backend = new MemoryBackend();
    backend.text = JSON.stringify({ schema: 1, quotes: {}, orders: {}, nonces: {}, collections: { checkouts: records } });
    const deps: TestDoorDeps = { ...base, store: await PaymentsStore.memory(backend) };
    for (const label of ['full', 'other']) {
      const quote = storedQuote(testQuoteId(label), NOW);
      deps.service.quotes.set(quote.id, quote);
    }
    return { deps, backend };
  }

  it(`at most ${MAX_OPEN_UCP_CHECKOUTS} never-paid UCP checkouts → checkouts_full; ACP is never refused because UCP is full`, async () => {
    const { deps, backend } = await storeWithOpenCheckouts(MAX_OPEN_UCP_CHECKOUTS, 'ucp');
    const checkout = createCheckoutService(deps);
    const refused = await checkout.create('ucp', { lineItems: [{ id: testQuoteId('full'), quantity: 1 }] });
    expect(refused).toMatchObject({ ok: false, reason: 'full', message: { code: 'checkouts_full' } });
    expect(backend.saves).toBe(0);
    const acp = await checkout.create({ door: 'acp', principal: 'p1' }, { lineItems: [{ id: testQuoteId('full'), quantity: 1 }] });
    expect(acp.ok).toBe(true);
  });

  it(`each ACP bearer has its own budget of ${MAX_OPEN_ACP_CHECKOUTS_PER_BEARER} open checkouts`, async () => {
    const { deps } = await storeWithOpenCheckouts(MAX_OPEN_ACP_CHECKOUTS_PER_BEARER, 'acp', 'bearer-a');
    const checkout = createCheckoutService(deps);
    const refused = await checkout.create({ door: 'acp', principal: 'bearer-a' }, { lineItems: [{ id: testQuoteId('full'), quantity: 1 }] });
    expect(refused).toMatchObject({ ok: false, reason: 'full', message: { code: 'checkouts_full' } });
    expect((await checkout.create({ door: 'acp', principal: 'bearer-b' }, { lineItems: [{ id: testQuoteId('full'), quantity: 1 }] })).ok).toBe(true);
    expect((await checkout.create('ucp', { lineItems: [{ id: testQuoteId('other'), quantity: 1 }] })).ok).toBe(true);
  });

  it('only a cancel/complete that changed state is marked for replay', async () => {
    const { deps, quote, checkout } = await setup();
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const unsupported = await checkout.complete('ucp', created.id, { credential: { ok: false, reason: 'no token' } });
    expect(unsupported?.stateChanged).toBeUndefined();
    const paid = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(paid?.stateChanged).toBe(true);
    expect((await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } }))?.stateChanged).toBeUndefined();
    expect((await checkout.cancel('ucp', created.id))?.stateChanged).toBe(true); // voids the hold

    const other = await checkoutCreate(deps, quote.id);
    expect((await checkout.cancel('ucp', other.id))?.stateChanged).toBe(true);
    expect((await checkout.cancel('ucp', other.id))?.stateChanged).toBeUndefined();
  });

  it('a checkout that never started paying is pruned an hour after its quote expired', async () => {
    let now = NOW;
    const deps = await doorDeps({ now: () => now });
    const quote = storedQuote(testQuoteId('prune'), NOW);
    deps.service.quotes.set(quote.id, quote);
    deps.store.rememberQuote(quote, NOW);
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id);
    now = new Date(Date.parse(quote.expiresAt) + 30 * 60_000);
    await deps.store.prune(now);
    expect(await checkout.get('ucp', created.id)).toBeDefined();
    now = new Date(Date.parse(quote.expiresAt) + 61 * 60_000);
    await deps.store.prune(now);
    expect(await checkout.get('ucp', created.id)).toBeUndefined();
  });

  it('buyer fields lose every C0/C1 control character (terminal escapes) before they are stored', async () => {
    const { deps, quote, checkout } = await setup();
    const result = await checkout.create('ucp', {
      lineItems: [{ id: quote.id, quantity: 1 }],
      buyer: { name: 'Ada\u001b[1A\u001b[2Ktotal: USD 0.00\u0007', email: 'ada@example.com\u0000\u009b', phone: '\u001b]52;c;cGF5bG9hZA==\u0007+1555' },
    });
    expect(checkoutView(result).buyer).toEqual({ name: 'Ada[1A[2Ktotal: USD 0.00', email: 'ada@example.com', phone: ']52;c;cGF5bG9hZA==+1555' });
    const stored = createCheckoutService(deps).list('ucp')[0];
    expect(JSON.stringify(stored?.buyer)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]|\\u00/);
  });

  it('buyer fields lose bidi overrides/isolates and line separators before they are stored', async () => {
    const { quote, checkout } = await setup();
    const result = await checkout.create('ucp', {
      lineItems: [{ id: quote.id, quantity: 1 }],
      buyer: { name: 'Ada\u202eLOVELACE\u202c \u2066x\u2069\u200e\u200f', email: 'ada@example.com\u2028', phone: '+1\u2029555\u202a\u202b\u202d\u2067\u2068' },
    });
    expect(checkoutView(result).buyer).toEqual({ name: 'AdaLOVELACE x', email: 'ada@example.com', phone: '+1555' });
  });

  it('a malformed buyer email is refused on create, update and complete; nothing is stored or paid', async () => {
    const { deps, quote, checkout } = await setup();
    const forged = 'a@b.c\nscopegraph: PAID order ord_forged \u001b[31mRED\u001b[0m\u2028\u202eRLO';
    for (const email of ['not-an-address', 'ada@localhost', 'a@@b.c', 'a@b..c', '@b.c', forged, `${'a'.repeat(320)}@example.com`]) {
      const refused = await checkout.create('ucp', { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email } });
      expect(refused, email).toMatchObject({ ok: false, reason: 'invalid_buyer', message: { code: 'invalid_buyer_email', field: 'buyer_email', severity: 'recoverable' } });
    }
    expect(checkout.list('ucp')).toHaveLength(0);

    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const update = await checkout.update('ucp', created.id, { buyer: { email: 'nobody' } });
    expect(update).toMatchObject({ ok: false, reason: 'invalid_buyer', message: { code: 'invalid_buyer_email' } });
    expect((await checkout.get('ucp', created.id))?.buyer).toEqual({ email: 'buyer@example.com' });

    const completed = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT }, buyer: { email: 'nobody' } });
    expect(completed?.messages).toContainEqual(expect.objectContaining({ code: 'invalid_buyer_email', field: 'buyer_email' }));
    expect(deps.service.payCalls).toEqual([]);
    expect((await checkout.get('ucp', created.id))?.buyer).toEqual({ email: 'buyer@example.com' });
  });

  it('quantity ≠ 1 → invalid_quantity', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const view = checkoutView(await checkout.create('ucp', { lineItems: [{ id: quote.id, quantity: 2 }] }));
    expect(view.status).toBe('incomplete');
    expect(view.messages[0]).toMatchObject({ code: 'invalid_quantity', field: 'quantity' });
  });

  it('valid quote with buyer email → ready_for_complete with frozen totals, quote expiry and continue_url', async () => {
    const { deps, quote } = await setup();
    const view = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    expect(view.status).toBe('ready_for_complete');
    expect(view.totals).toEqual({ subtotalCents: 7300, taxCents: 0, totalCents: 7300 });
    expect(view.currency).toBe('USD');
    expect(view.expiresAt).toBe(quote.expiresAt);
    expect(view.continueUrl).toBe(`https://pay.example/quotes/${quote.id}/pay`);
    expect(view.messages).toEqual([]);
  });

  it('owner_approves without buyer email → incomplete field_required on buyer email', async () => {
    const { deps, quote } = await setup();
    const view = await checkoutCreate(deps, quote.id);
    expect(view.status).toBe('incomplete');
    expect(view.messages[0]).toMatchObject({ code: 'field_required', field: 'buyer_email' });
    const updated = checkoutView(await createCheckoutService(deps).update('ucp', view.id, { buyer: { email: 'late@example.com' } }));
    expect(updated.status).toBe('ready_for_complete');
  });

  it('complete → complete_in_progress with expires_at = approval deadline and order reference', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const view = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(view?.status).toBe('complete_in_progress');
    expect(view?.expiresAt).toBe(view?.order?.approvalDeadline);
    expect(view?.order?.status).toBe('awaiting_approval');
    expect(view?.messages[0]).toMatchObject({ type: 'info', code: 'awaiting_approval' });
    expect(deps.service.payCalls).toEqual([
      { quoteId: quote.id, spt: SPT, checkoutId: created.id, buyer: { email: 'buyer@example.com' } },
    ]);
  });

  it('paid order → completed with permalink; order served from the record, not live lookup', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    const order = deps.service.orders.values().next().value as Order;
    order.status = 'paid';
    const view = await checkout.get('ucp', created.id);
    expect(view?.status).toBe('completed');
    expect(view?.order).toMatchObject({ id: order.id, permalinkUrl: `https://pay.example/orders/${order.id}` });
  });

  it('declined complete → back to ready_for_complete with recoverable payment_declined; attempts recorded', async () => {
    const { deps, quote } = await setup();
    deps.service.onPay = () => ({ ok: false, error: 'payment_declined', message: 'card was declined (test)' });
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const view = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(view?.status).toBe('ready_for_complete');
    expect(view?.messages[0]).toMatchObject({ code: 'payment_declined', severity: 'recoverable' });
    const again = await checkout.get('ucp', created.id);
    expect(again?.status).toBe('ready_for_complete');
  });

  it(`payment_failed order after ${MAX_COMPLETE_ATTEMPTS} completes → canceled with too_many_attempts`, async () => {
    const { deps, quote } = await setup();
    deps.service.onPay = ({ quoteId, door, checkoutId }) => {
      const stored = deps.service.quotes.get(quoteId)!;
      const order: Order = {
        id: `ord_fail${String(deps.service.payCalls.length).padStart(3, '0')}`,
        quoteId,
        offering: stored.offering,
        request: stored.request,
        quote: stored.quote,
        confirmation: 'owner_approves',
        door,
        checkoutId,
        createdAt: NOW.toISOString(),
        stripe: {},
        status: 'payment_failed',
        pendingHooks: [],
        version: 0,
      };
      deps.service.orders.set(order.id, order);
      return { ok: true, value: structuredClone(order) };
    };
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    for (let i = 0; i < MAX_COMPLETE_ATTEMPTS - 1; i++) {
      const view = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
      expect(view?.status).toBe('ready_for_complete');
    }
    // The third attempt is allowed and, once it fails too, closes the checkout.
    const third = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(third?.status).toBe('canceled');
    expect(third?.messages.map((m) => m.code)).toEqual(expect.arrayContaining(['payment_declined', 'too_many_attempts']));
    const spent = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(spent?.status).toBe('canceled');
    expect(deps.service.payCalls).toHaveLength(MAX_COMPLETE_ATTEMPTS);
  });

  it('unsupported credential → ready_for_complete kept, recoverable unsupported_instrument, no order', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const view = await checkout.complete('ucp', created.id, { credential: { ok: false, reason: 'Credential type "pk_payment_token" is not supported' } });
    expect(view?.status).toBe('ready_for_complete');
    expect(view?.messages[0]).toMatchObject({ code: 'unsupported_instrument', field: 'payment' });
    expect(deps.service.payCalls).toHaveLength(0);
  });

  it('cancel with no order → canceled terminal; later complete refused', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const canceled = await checkout.cancel('ucp', created.id);
    expect(canceled?.status).toBe('canceled');
    const again = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(again?.status).toBe('canceled');
    expect(again?.messages[0]).toMatchObject({ code: 'checkout_canceled', severity: 'unrecoverable' });
  });

  it('cancel while awaiting approval → buyer cancel voids the hold, then canceled', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    const order = deps.service.orders.values().next().value as Order;
    const view = await checkout.cancel('ucp', created.id);
    expect(deps.service.cancelCalls).toEqual([order.id]);
    expect(view?.status).toBe('canceled');
  });

  it('cancel mid-authorization → stays complete_in_progress with recoverable message, order untouched', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    const order = deps.service.orders.values().next().value as Order;
    order.status = 'authorizing';
    const view = await checkout.cancel('ucp', created.id);
    expect(view?.status).toBe('complete_in_progress');
    expect(view?.messages[0]).toMatchObject({ code: 'payment_in_progress', severity: 'recoverable' });
    expect(deps.service.cancelCalls).toEqual([]);
  });

  it('update refused with checkout_locked while the order is live', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    const view = checkoutView(await checkout.update('ucp', created.id, { buyer: { email: 'other@example.com' } }));
    expect(view.status).toBe('complete_in_progress');
    expect(view.messages[0]).toMatchObject({ code: 'checkout_locked' });
    expect(deps.service.payCalls).toHaveLength(1);
  });

  it('live order owned by another checkout or door → incomplete quote_in_use', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const foreign = checkoutView(await checkout.create('ucp', { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'first@example.com' } }));
    await checkout.complete('ucp', foreign.id, { credential: { ok: true, spt: SPT } });
    const second = await checkoutCreate(deps, quote.id, { email: 'second@example.com' });
    expect(second?.status).toBe('incomplete');
    expect(second?.messages[0]).toMatchObject({ code: 'quote_in_use', field: 'quote' });
  });

  it('requote after the quote changed → incomplete with price_changed, blocking', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    deps.service.onPay = ({ quoteId, door, checkoutId }) => {
      const stored = deps.service.quotes.get(quoteId)!;
      const order: Order = {
        id: 'ord_requote0000000000000000a',
        quoteId,
        offering: stored.offering,
        request: stored.request,
        quote: stored.quote,
        confirmation: 'owner_approves',
        door,
        checkoutId,
        createdAt: NOW.toISOString(),
        stripe: {},
        status: 'canceled',
        statusReason: 'requote_required',
        pendingHooks: [],
        version: 0,
      };
      deps.service.orders.set(order.id, order);
      return { ok: true, value: structuredClone(order) };
    };
    const view = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(view?.status).toBe('incomplete');
    expect(view?.messages[0]).toMatchObject({ code: 'price_changed', severity: 'recoverable' });
  });

  it('checkouts are isolated per door: ucp cannot see acp records', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const acp = checkoutView(await checkout.create({ door: 'acp', principal: 'p1' }, { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'buyer@example.com' } }));
    expect(await checkout.get('ucp', acp.id)).toBeUndefined();
    expect((await checkout.get({ door: 'acp', principal: 'p1' }, acp.id))?.status).toBe('ready_for_complete');
  });

  it('ACP checkouts are bound to their bearer: another principal sees nothing', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    const created = checkoutView(await checkout.create({ door: 'acp', principal: 'token-a-hash' }, { lineItems: [{ id: quote.id, quantity: 1 }], buyer: { email: 'buyer@example.com' } }));
    expect(await checkout.get({ door: 'acp', principal: 'token-b-hash' }, created.id)).toBeUndefined();
    expect(await checkout.update({ door: 'acp', principal: 'token-b-hash' }, created.id, { buyer: { email: 'x@example.com' } })).toBeUndefined();
    expect(await checkout.complete({ door: 'acp', principal: 'token-b-hash' }, created.id, { credential: { ok: true, spt: SPT } })).toBeUndefined();
    expect(await checkout.cancel({ door: 'acp', principal: 'token-b-hash' }, created.id)).toBeUndefined();
    expect(deps.service.payCalls).toHaveLength(0);
    expect((await checkout.get({ door: 'acp', principal: 'token-a-hash' }, created.id))?.status).toBe('ready_for_complete');
  });

  it('payment_pending complete → non-final status, recoverable info, no attempt counted; retry pays again', async () => {
    const { deps, quote } = await setup();
    const order: Omit<Order, 'checkoutId'> & { checkoutId?: string } = {
      id: 'ord_pending00000000000000a',
      quoteId: quote.id,
      offering: quote.offering,
      request: quote.request,
      quote: quote.quote,
      confirmation: 'owner_approves',
      door: 'ucp',
      createdAt: NOW.toISOString(),
      stripe: {},
      status: 'awaiting_approval',
      pendingHooks: [],
      version: 0,
    };
    let pending = true;
    deps.service.onPay = () => {
      if (pending) return { ok: false, error: 'payment_pending', message: 'outcome unknown (test)' };
      const settled = { ...order, checkoutId: deps.service.payCalls.at(-1)?.checkoutId };
      deps.service.orders.set(settled.id, settled);
      return { ok: true, value: structuredClone(settled) };
    };
    const checkout = createCheckoutService(deps);
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    const view = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(view?.status).toBe('ready_for_complete'); // non-final
    expect(view?.paymentPending).toBe(true);
    expect(view?.messages[0]).toMatchObject({ type: 'info', code: 'payment_pending' });
    expect(String(view?.messages[0]?.content)).toContain('SAME payment token');
    expect(String(view?.messages[0]?.content)).not.toContain('not charged');
    // The pending try is not counted: MAX_COMPLETE_ATTEMPTS pending tries still leave the
    // checkout open for a final one.
    for (let i = 0; i < MAX_COMPLETE_ATTEMPTS; i++) {
      const again = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
      expect(again?.paymentPending).toBe(true);
    }
    pending = false;
    const settled = await checkout.complete('ucp', created.id, { credential: { ok: true, spt: SPT } });
    expect(settled?.paymentPending).toBeUndefined();
    expect(settled?.status).toBe('complete_in_progress');
    expect(deps.service.payCalls).toHaveLength(MAX_COMPLETE_ATTEMPTS + 2);
  });

  it('continue_url falls back to the public root when the business has no website', async () => {
    const deps = await doorDeps({ now: () => NOW, graph: graph([], {}) });
    const quote = storedQuote(testQuoteId('nowebsite'), NOW);
    deps.service.quotes.set(quote.id, quote);
    const view = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    expect(view.status).toBe('ready_for_complete');
    expect(view.continueUrl).toBe(`https://pay.example/quotes/${quote.id}/pay`);
    // Once the quote expires the checkout is incomplete: never the raw handoff template, the public root.
    quote.expiresAt = new Date(NOW.getTime() - 1).toISOString();
    const stale = await createCheckoutService(deps).get('ucp', view.id);
    expect(stale?.status).toBe('incomplete');
    expect(stale?.messages[0]).toMatchObject({ code: 'quote_expired' });
    expect(stale?.continueUrl).toBe('https://pay.example');
  });

  it('order-event delivery state is stored on the record and reset when the quote changes', async () => {
    const { deps, quote } = await setup();
    const checkout = createCheckoutService(deps);
    expect(checkout.getOrderEvents('chk_none0000000000000000a')).toBeUndefined();
    const created = await checkoutCreate(deps, quote.id, { email: 'buyer@example.com' });
    await checkout.setOrderEvents(created.id, { orderId: 'ord_test001', lastStatus: 'manual_review', created: true, lastSentAt: NOW.toISOString(), attempts: 0, nextAttemptAt: NOW.toISOString() });
    expect(checkout.getOrderEvents(created.id)).toMatchObject({ orderId: 'ord_test001', created: true });
    const other = storedQuote(testQuoteId('other'), NOW);
    deps.service.quotes.set(other.id, other);
    await checkout.update('ucp', created.id, { lineItems: [{ id: other.id, quantity: 1 }] });
    expect(checkout.getOrderEvents(created.id)).toBeUndefined();
  });

  it('unknown checkout id → undefined (callers render not_found)', async () => {
    const { deps } = await setup();
    expect(await createCheckoutService(deps).get('ucp', 'chk_unknown00000000000000a')).toBeUndefined();
  });
});
