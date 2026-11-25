/**
 * Quotes and the funnel — how a payable quote is minted and how an order is
 * started from it: `createQuote`, the funnel checks every door shares,
 * `newOrder`, and the link door (`startLinkOrder` + its Checkout Session).
 *
 * Invariants that live here:
 * - Quotes come only from server evaluation; fresh ones live in memory
 *   (bounded) and become durable with the first order started from them.
 * - One live order per quote: the quote lock is held while looking for the
 *   live order, running the funnel and inserting the new order. The live
 *   order is looked up BEFORE the stored quote (it carries its own frozen
 *   copy; the stored quote may be pruned).
 * - The funnel re-checks the frozen request with fresh facts; a changed
 *   outcome or price refuses and expires the quote.
 * - Open unpaid orders are capped per door, and the cap check and the insert
 *   it admits share the `order-admission` lock (`admitOrder`), so concurrent
 *   funnels on different quotes can never overshoot it.
 * - The link order (with the session expiry it will send) is durable BEFORE
 *   the Checkout Session create, so retries replay the same idempotency key.
 */
import type { Quote } from '../../engine/types.js';
import type { Door, ObservedCheckoutSession, Order, OrderStatus, PublicOrder, ScopedRequest, ServiceResult, StoredQuote } from '../types.js';
import { DefinitiveGatewayError } from '../types.js';
import { newId } from '../store/index.js';
import { stripControls } from '../buyer.js';
import { isTwoDecimalCurrency } from '../../pricing/currency.js';
import { minimumChargeMinorUnits } from '../config.js';
import { computeApprovalDeadline, MIN_APPROVAL_LEAD_MS } from './deadline.js';
import type { OrderCore } from './core.js';
import { errorText, fail, isLive, toPublicOrder } from './core.js';

const MAX_ORDERS_PER_QUOTE = 3;
/**
 * Per client (rate-limit key): unexpired unstarted quotes plus orders started in the last quote
 * TTL that never held money (unpaid links, junk payment tokens). The memory cap stays the
 * global backstop for quotes, `MAX_OPEN_UNPAID_ORDERS_PER_DOOR` for orders.
 */
export const MAX_UNPAID_PER_CLIENT = 50;
/**
 * The same load summed over every client in one IPv6 /48 (`clientNetwork`), so a subscriber
 * cannot multiply `MAX_UNPAID_PER_CLIENT` by rotating /64s. IPv4 has no network quota: agent
 * platforms and carrier NAT share IPv4 ranges.
 */
export const MAX_UNPAID_PER_NETWORK = 200;
/**
 * Open orders that never held money (awaiting_payment / authorizing), counted per door: a new
 * order on a door is refused at this many, so a flood of unpaid payment links never blocks the
 * token doors (UCP, ACP, MPP), nor the other way round.
 */
export const MAX_OPEN_UNPAID_ORDERS_PER_DOOR = 2_000;
const QUOTES_FULL_LOG_EVERY_MS = 60_000;
const LINK_SESSION_MIN_MS = 31 * 60_000;
/** Serializes the per-door cap check with the insert it admits (innermost: nothing is taken under it). */
const ORDER_ADMISSION_LOCK = 'order-admission';

/**
 * The network a client key belongs to, for `MAX_UNPAID_PER_NETWORK`. Client keys come from
 * `clientBucketKey` (src/server/app.ts): an IPv6 key `a:b:c:d::/64` maps to `a:b:c::/48`.
 * IPv4 addresses and any other key (e.g. `unknown`) have no network.
 */
export function clientNetwork(client: string): string | undefined {
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(client);
  return v6 === null ? undefined : `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
}

/** No card hold or capture ever happened on it (unpaid payment link, junk or declined payment token). */
function neverHeldMoney(order: Readonly<Order>): boolean {
  switch (order.status) {
    case 'awaiting_payment':
    case 'authorizing':
    case 'payment_failed':
      return true;
    case 'canceled':
    case 'expired':
      return order.stripe.paymentIntentId === undefined && order.voidOutcome === undefined;
    default:
      return false;
  }
}

/**
 * Under owner approval, would a card held as late as `lastHold` still leave the
 * owner `MIN_APPROVAL_LEAD_MS` to approve? (Otherwise the hold is only voided as
 * `date_too_soon`.) Always true for `instant` and for undated requests.
 */
function approvalFitsBy(core: OrderCore, date: string | undefined, lastHold: Date): boolean {
  if (core.config.confirmation !== 'owner_approves' || date === undefined) return true;
  const deadline = computeApprovalDeadline({
    now: lastHold,
    approvalWindowHours: core.config.approvalWindowHours,
    date,
    business: core.getGraph().business,
  });
  return deadline.getTime() >= lastHold.getTime() + MIN_APPROVAL_LEAD_MS;
}

/**
 * In memory only (bounded, TTL-pruned); durable once an order starts from it.
 * The same client asking again for the same offering, request and price gets the live quote
 * it already holds (when at least half its lifetime is left) instead of a new one.
 * Undefined (not payable) when `client` is at `MAX_UNPAID_PER_CLIENT`, its network at
 * `MAX_UNPAID_PER_NETWORK`, the memory store is full of unexpired quotes, or — under owner
 * approval — a card held as late as the quote's expiry would leave the owner less than
 * `MIN_APPROVAL_LEAD_MS` to approve (the hold would only be voided as `date_too_soon`).
 */
export async function createQuote(core: OrderCore, offering: string, request: ScopedRequest, quote: Quote, client?: string): Promise<StoredQuote | undefined> {
  if (!isTwoDecimalCurrency(quote.currency)) {
    // Amounts compile to ×100 minor units: charging any other currency would be wrong by a factor.
    core.log(`not payable: ${quote.currency} is not a two-decimal currency (payments support two-decimal currencies only)`);
    return undefined;
  }
  if (quote.totalCents < minimumChargeMinorUnits(quote.currency)) return undefined;
  const now = core.now();
  const t = now.getTime();
  const ttlMs = core.config.quoteTtlMinutes * 60_000;
  if (!approvalFitsBy(core, request.date, new Date(t + ttlMs))) return undefined;
  if (client !== undefined) {
    const requestJson = JSON.stringify(request);
    const quoteJson = JSON.stringify(quote);
    const held = core.store.findUnstartedQuote(client, (candidate) =>
      candidate.offering === offering
      && Date.parse(candidate.expiresAt) - t >= ttlMs / 2
      && JSON.stringify(candidate.request) === requestJson
      && JSON.stringify(candidate.quote) === quoteJson);
    if (held !== undefined) return held;
    const since = t - ttlMs;
    const recentUnpaid = (order: Readonly<Order>): boolean => Date.parse(order.createdAt) >= since && neverHeldMoney(order);
    const load = core.store.unstartedQuotesHeldBy((holder) => holder === client, now)
      + core.store.countOrders((order) => order.client === client && recentUnpaid(order));
    if (load >= MAX_UNPAID_PER_CLIENT) {
      if (t - core.clientQuotaLoggedAt >= QUOTES_FULL_LOG_EVERY_MS) {
        core.clientQuotaLoggedAt = t;
        core.log(
          `client ${stripControls(client).slice(0, 64)} holds ${String(MAX_UNPAID_PER_CLIENT)} unpaid quotes/orders: `
            + 'its new quotes are not payable until some expire or are paid — possible scope flood',
        );
      }
      return undefined;
    }
    const network = clientNetwork(client);
    if (network !== undefined) {
      const inNetwork = (holder: string | undefined): boolean => holder !== undefined && clientNetwork(holder) === network;
      const networkLoad = core.store.unstartedQuotesHeldBy(inNetwork, now)
        + core.store.countOrders((order) => recentUnpaid(order) && inNetwork(order.client));
      if (networkLoad >= MAX_UNPAID_PER_NETWORK) {
        if (t - core.clientQuotaLoggedAt >= QUOTES_FULL_LOG_EVERY_MS) {
          core.clientQuotaLoggedAt = t;
          core.log(
            `network ${network} holds ${String(MAX_UNPAID_PER_NETWORK)} unpaid quotes/orders: `
              + 'its new quotes are not payable until some expire or are paid — possible scope flood',
          );
        }
        return undefined;
      }
    }
  }
  const stored = core.store.rememberQuote({
    id: newId('qt'),
    offering,
    request: structuredClone(request),
    quote: structuredClone(quote),
    createdAt: now.toISOString(),
    expiresAt: new Date(t + ttlMs).toISOString(),
    ...(client !== undefined ? { client } : {}),
  }, now);
  if (stored === undefined && t - core.quotesFullLoggedAt >= QUOTES_FULL_LOG_EVERY_MS) {
    core.quotesFullLoggedAt = t;
    core.log('quote store full (unexpired quotes at the cap): new quotes are not payable until some expire — possible scope flood');
  }
  return stored;
}

/** True (and logged, throttled) when `door` already has `MAX_OPEN_UNPAID_ORDERS_PER_DOOR` open unpaid orders. */
function doorFull(core: OrderCore, door: Door): boolean {
  const open = core.store.countOrders((order) => order.door === door && (order.status === 'awaiting_payment' || order.status === 'authorizing'));
  if (open < MAX_OPEN_UNPAID_ORDERS_PER_DOOR) return false;
  const t = core.now().getTime();
  if (t - core.unpaidOrdersLoggedAt >= QUOTES_FULL_LOG_EVERY_MS) {
    core.unpaidOrdersLoggedAt = t;
    core.log(`${String(MAX_OPEN_UNPAID_ORDERS_PER_DOOR)} unpaid ${door} orders are open: new ${door} orders are refused until some are paid or expire — possible flood`);
  }
  return true;
}

const DOOR_FULL = 'Too many unpaid orders are open right now; nothing was started. Try again in a few minutes.';

/**
 * Quote must be unexpired, under the attempt cap, payable, and still qualify at the same price;
 * `door` must have room for one more unpaid order (checked again, atomically, by `admitOrder`;
 * this early check spares the re-check's facts call during a flood). Quote lock held.
 */
export async function funnel(core: OrderCore, quote: StoredQuote, door: Door): Promise<ServiceResult<StoredQuote>> {
  if (core.now().getTime() >= Date.parse(quote.expiresAt)) {
    return fail('quote_expired', `Quote ${quote.id} has expired. Scope the request again for a fresh quote.`);
  }
  if (core.store.ordersForQuote(quote.id).length >= MAX_ORDERS_PER_QUOTE) {
    return fail('too_many_attempts', `Quote ${quote.id} has reached ${String(MAX_ORDERS_PER_QUOTE)} payment attempts. Scope the request again.`);
  }
  if (doorFull(core, door)) return fail('door_unavailable', DOOR_FULL);
  const minimum = minimumChargeMinorUnits(quote.quote.currency);
  if (quote.quote.totalCents < minimum) {
    return fail('amount_too_small', `The total is below the minimum card payment (${String(minimum)} minor units).`);
  }
  if (!(await core.recheck(quote))) {
    await core.store.expireQuote(quote.id, core.now().toISOString());
    return fail('requote_required', 'The request no longer qualifies at this price (availability or prices changed). Scope it again for a fresh quote.');
  }
  return { ok: true, value: quote };
}

/** Insert a new unpaid order if its door is still under `MAX_OPEN_UNPAID_ORDERS_PER_DOOR` (check and insert are atomic). Quote lock held. */
export function admitOrder(core: OrderCore, order: Order): Promise<ServiceResult<Order>> {
  return core.store.locks.withLock(ORDER_ADMISSION_LOCK, async (): Promise<ServiceResult<Order>> => {
    if (doorFull(core, order.door)) return fail('door_unavailable', DOOR_FULL);
    return { ok: true, value: await core.store.insertOrder(order) };
  });
}

/** A new order with a frozen copy of the quote and the current confirmation mode. */
export function newOrder(core: OrderCore, quote: StoredQuote, door: Door, status: OrderStatus, extra: Partial<Order>): Order {
  return {
    id: newId('ord'),
    quoteId: quote.id,
    offering: quote.offering,
    request: structuredClone(quote.request),
    quote: structuredClone(quote.quote),
    confirmation: core.config.confirmation,
    door,
    ...(quote.client !== undefined ? { client: quote.client } : {}),
    createdAt: core.now().toISOString(),
    stripe: {},
    status,
    pendingHooks: [],
    version: 0,
    ...extra,
  };
}

/** Link door: creates/reuses the link order and its Checkout Session. */
export async function startLinkOrder(core: OrderCore, quoteId: string): Promise<ServiceResult<{ order: PublicOrder; url: string }>> {
  const started = await core.withQuoteLock(quoteId, async (): Promise<ServiceResult<Order>> => {
    // The live order first: it carries its own frozen quote (the stored one may be pruned).
    const live = core.store.ordersForQuote(quoteId).find(isLive);
    if (live !== undefined) {
      if (live.door !== 'link') return fail('quote_in_use', `Quote ${quoteId} is already being paid through ${live.door}.`);
      if (live.status !== 'awaiting_payment') return fail('invalid_state', `Order ${live.id} for this quote is ${live.status}.`);
      return { ok: true, value: live };
    }
    const quote = core.store.getQuote(quoteId);
    if (quote === undefined) return fail('quote_not_found', `Quote ${quoteId} not found. Scope the request first.`);
    const checked = await funnel(core, quote, 'link');
    if (!checked.ok) return checked;
    const now = core.now().getTime();
    const sessionExpiry = Math.max(Date.parse(quote.expiresAt), now + LINK_SESSION_MIN_MS);
    // The session can outlive the quote: a card held at its expiry must still leave the owner time to approve.
    if (!approvalFitsBy(core, quote.request.date, new Date(sessionExpiry))) {
      return fail('requote_required', 'This booking is too close to its start for the business to approve a card payment in time. Choose a later date or contact the business.');
    }
    // Persisted BEFORE the Stripe call: retries send exactly this expiry under the same idempotency key.
    const order = newOrder(core, quote, 'link', 'awaiting_payment', {
      stripe: { checkoutSessionExpiresAt: new Date(sessionExpiry).toISOString() },
    });
    return admitOrder(core, order);
  });
  if (!started.ok) return started;

  return core.withOrderLock(started.value.id, async () => {
    const order = core.store.getOrder(started.value.id);
    if (order === undefined) return fail('order_not_found', 'Order disappeared.');
    if (order.status !== 'awaiting_payment') return fail('invalid_state', `Order ${order.id} is ${order.status}.`);
    const sessionExpiry = Date.parse(order.stripe.checkoutSessionExpiresAt ?? '');
    if (core.now().getTime() >= sessionExpiry) {
      // The reconciler expires it at Stripe and closes the order within a sweep.
      return fail('quote_expired', 'The payment page for this quote has expired. Scope the request again for a fresh quote.');
    }
    if (order.stripe.checkoutUrl !== undefined) {
      return { ok: true, value: { order: toPublicOrder(order, core.config.publicUrl), url: order.stripe.checkoutUrl } };
    }
    const bound = await createLinkSession(core, order, 'link_start');
    if (!bound.ok) return bound;
    const url = bound.value.stripe.checkoutUrl;
    if (url === undefined) return fail('door_unavailable', 'Stripe returned no Checkout URL.');
    return { ok: true, value: { order: toPublicOrder(bound.value, core.config.publicUrl), url } };
  });
}

/** Create (or replay, same idempotency key) the order's Checkout Session. Order lock held. */
export async function createLinkSession(core: OrderCore, order: Order, op: string): Promise<ServiceResult<Order>> {
  const graph = core.getGraph();
  const fill = (template: string | undefined): string =>
    (template ?? `${core.config.publicUrl}/orders/{order}`).replaceAll('{order}', order.id);
  let session: ObservedCheckoutSession;
  try {
    session = await core.gateway.createCheckoutSession({
      order,
      offeringName: graph.offerings[order.offering]?.name ?? order.offering,
      successUrl: fill(core.config.successUrl),
      cancelUrl: fill(core.config.cancelUrl),
    });
  } catch (err) {
    if (err instanceof DefinitiveGatewayError) {
      core.log(`Checkout Session for ${order.id} refused: ${err.message}`);
      await core.commit(order, op, { status: 'canceled', reason: 'checkout_unavailable' });
      return fail('door_unavailable', 'The payment page could not be created. Try again later or use another payment method.');
    }
    core.log(`Checkout Session for ${order.id} ambiguous: ${errorText(err)}`);
    return fail('door_unavailable', 'The payment provider did not respond. Retry in a moment (the same payment page will be returned).');
  }
  const bound = await core.commit(order, op, {}, (draft) => {
    draft.stripe.checkoutSessionId = session.id;
    if (session.url !== undefined) draft.stripe.checkoutUrl = session.url;
  });
  return { ok: true, value: bound };
}
