/**
 * Protocol-neutral checkout shared by the UCP and ACP doors (docs/payments.md § The four doors).
 *
 * A checkout (`chk_…`) wraps exactly one quote (`line_items[0].item.id = qt_…`). It never
 * scopes and never prices: totals come from the server-frozen quote. The order is created
 * only at complete, through `OrderService.payWithSpt` (the single quote → order funnel).
 *
 * Status is derived on every read from the record, the quote and the checkout's order, so a
 * webhook, reconciler pass or owner approval is reflected without the checkout being told.
 * Every mutation runs under the per-checkout lock (`checkout:<id>`), which is taken before the
 * order service takes its quote/order locks (lock order checkout → quote → order).
 *
 * Admission (create, and an update that changes line items) stores nothing unless every
 * line-item id is a well-formed quote id and the first quote exists and is live; otherwise
 * the agent gets the same guidance as a refusal and nothing is persisted. Stored checkouts are
 * capped per quote and globally; the cap check and the write share the `checkout-admission`
 * lock (taken last, never held while taking another lock).
 */
import { IS_TERMINAL } from '../types.js';
import type { Buyer, DoorDeps, Order, OrderStatus, ServiceError, StoredQuote } from '../types.js';
import type { QuoteLine } from '../../engine/types.js';
import { isId, newId } from '../store/ids.js';
import { cleanBuyer, isEmailShaped } from '../buyer.js';

const CHECKOUT_COLLECTION = 'checkouts';
/** Completes that may start a new order per checkout (card-testing guard). */
export const MAX_COMPLETE_ATTEMPTS = 3;
/** Line items accepted per checkout; adapters reject larger requests as malformed. */
export const MAX_LINE_ITEMS = 10;
/** Stored checkouts one quote may have (any status): an agent continues one of them or re-scopes. */
export const MAX_CHECKOUTS_PER_QUOTE = 3;
/** Stored anonymous UCP checkouts that never reached a paid order: the UCP storage backstop. */
export const MAX_OPEN_UCP_CHECKOUTS = 5_000;
/** The same, per ACP bearer: authenticated platforms never share a budget with UCP or each other. */
export const MAX_OPEN_ACP_CHECKOUTS_PER_BEARER = 1_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NEVER_PAID_RETENTION_MS = 2 * DAY_MS;
const PAID_RETENTION_MS = 90 * DAY_MS;
/** A record whose complete started but whose order id was never stored (crash): outlive any approval window. */
const ORPHANED_ATTEMPT_RETENTION_MS = 7 * DAY_MS;
/** A checkout that never started paying is dead once its quote is gone; kept this long past the quote's expiry. */
const UNSTARTED_AFTER_QUOTE_MS = HOUR_MS;

type CheckoutDoor = 'ucp' | 'acp';

type CheckoutStatus = 'incomplete' | 'ready_for_complete' | 'complete_in_progress' | 'completed' | 'canceled';

/** Who is acting: the UCP door, or an ACP bearer (sha256 of the token) — ACP checkouts are bound to their token. */
export type CheckoutOwner = 'ucp' | { door: 'acp'; principal: string };

/** ACP order-webhook delivery state, kept on the checkout record so it lives exactly as long as the checkout. */
export interface OrderEventDelivery {
  orderId: string;
  /** Status last delivered to the webhook (unset until one succeeds). */
  lastStatus?: string;
  /** Whether `order_create` was already sent (later sends are `order_update`). */
  created: boolean;
  lastSentAt?: string;
  attempts: number;
  nextAttemptAt: string;
}

export interface LineItemInput {
  id: string;
  quantity: number;
}

interface CheckoutRecord {
  id: string; // chk_…
  /** Protocol that created it; the other protocol cannot see it. */
  door: CheckoutDoor;
  /** sha256 of the ACP bearer that created it (undefined for UCP); other bearers get 404. */
  principal?: string;
  /** As submitted; valid only when it is exactly one quote with quantity 1. */
  lineItems: LineItemInput[];
  buyer?: Buyer;
  /** Latest order started by this checkout (may be terminal). */
  orderId?: string;
  /** Completes that started a new order. */
  attempts: number;
  /** Buyer canceled with no live order (canceled orders are reflected via the order). */
  canceled: boolean;
  /** ACP order-webhook delivery state (see OrderEventDelivery). */
  orderEvents?: OrderEventDelivery;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Field a message points at; adapters render it as a protocol-specific JSONPath. */
export type CheckoutField = 'line_items' | 'quote' | 'quantity' | 'buyer_email' | 'payment';

export type CheckoutMessageCode =
  | 'quote_required'
  | 'quote_expired'
  | 'quote_in_use'
  | 'amount_too_small'
  | 'invalid_line_items'
  | 'invalid_quantity'
  | 'invalid_buyer_email'
  | 'field_required'
  | 'payment_declined'
  | 'price_changed'
  | 'date_too_soon'
  | 'unsupported_instrument'
  | 'different_credential'
  | 'too_many_attempts'
  | 'checkout_locked'
  | 'payment_in_progress'
  | 'payment_pending'
  | 'awaiting_approval'
  | 'order_closed'
  | 'checkout_completed'
  | 'checkout_canceled'
  | 'too_many_checkouts'
  | 'checkouts_full'
  | 'service_error';

export interface CheckoutMessage {
  type: 'error' | 'info';
  code: CheckoutMessageCode;
  /** Errors only. */
  severity?: 'recoverable' | 'unrecoverable';
  field?: CheckoutField;
  content: string;
}

interface CheckoutLineItemView {
  /** Response line id (`li_<n>`). */
  id: string;
  /** Item id as submitted (the quote id when valid). */
  itemId: string;
  title: string;
  quantity: number;
  amountCents: number;
}

interface CheckoutQuoteView {
  id: string;
  offering: string;
  title: string;
  expiresAt: string;
  lines: QuoteLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

interface CheckoutOrderView {
  id: string;
  status: OrderStatus;
  statusReason?: string;
  approvalDeadline?: string;
  permalinkUrl: string;
}

export interface CheckoutView {
  id: string;
  door: CheckoutDoor;
  status: CheckoutStatus;
  /** ISO 4217, uppercase. */
  currency: string;
  lineItems: CheckoutLineItemView[];
  quote?: CheckoutQuoteView;
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
  buyer?: Buyer;
  messages: CheckoutMessage[];
  /** Quote expiry while open; the approval deadline while awaiting the owner. */
  expiresAt?: string;
  continueUrl?: string;
  order?: CheckoutOrderView;
  /** True only for a complete whose payment outcome is unknown: recoverable, must be retried, never cached. */
  paymentPending?: boolean;
  /**
   * True when this complete/cancel changed state (started or resumed a payment, canceled the
   * checkout or its hold). Doors store an idempotent replay only then: a no-op answer is
   * re-derived on retry, so fresh keys on a no-op call never grow the store.
   */
  stateChanged?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the adapter extracted from the protocol's payment payload. */
export type CheckoutCredential = { ok: true; spt: string } | { ok: false; reason: string };

/** Why a create/update stored nothing: unusable line items or buyer email, the quote's checkout cap, or the global cap. */
export type CheckoutRefusalReason = 'invalid_items' | 'invalid_buyer' | 'quote_busy' | 'full';

/** HTTP status each door answers a refusal with (the body is the protocol's error shape). */
export const REFUSAL_STATUS: Record<CheckoutRefusalReason, 400 | 409 | 503> = { invalid_items: 400, invalid_buyer: 400, quote_busy: 409, full: 503 };

export interface CheckoutRefusal {
  ok: false;
  reason: CheckoutRefusalReason;
  message: CheckoutMessage;
}

export type CheckoutResult = { ok: true; view: CheckoutView } | CheckoutRefusal;

export interface CheckoutService {
  /** Refused (nothing stored) unless the line items name a live quote and the caps allow another checkout. */
  create(owner: CheckoutOwner, input: { lineItems: LineItemInput[]; buyer?: Buyer }): Promise<CheckoutResult>;
  /** Undefined when unknown, pruned, owned by the other door, or (ACP) by another bearer. */
  get(owner: CheckoutOwner, id: string): Promise<CheckoutView | undefined>;
  /**
   * Provided fields replace the stored ones; refused (`checkout_locked`) while an order is live.
   * New line items are admitted like `create` (a refusal leaves the checkout unchanged).
   */
  update(owner: CheckoutOwner, id: string, patch: { lineItems?: LineItemInput[]; buyer?: Buyer }): Promise<CheckoutResult | undefined>;
  /** `buyer`, when given, replaces the stored buyer before completing (ACP complete carries it). */
  complete(owner: CheckoutOwner, id: string, input: { credential: CheckoutCredential; buyer?: Buyer }): Promise<CheckoutView | undefined>;
  cancel(owner: CheckoutOwner, id: string): Promise<CheckoutView | undefined>;
  /** Stored records of one door (ACP order-webhook delivery scans these). */
  list(door: CheckoutDoor): CheckoutRecord[];
  /** ACP order-webhook delivery state stored on the checkout record (undefined when never delivered). */
  getOrderEvents(id: string): OrderEventDelivery | undefined;
  /** Updates the delivery state under the checkout lock; does not touch `updatedAt`. */
  setOrderEvents(id: string, next: OrderEventDelivery): Promise<void>;
}

/** What an order means for its checkout. */
type Disposition =
  | { kind: 'none' }
  | { kind: 'live'; order: Order }
  | { kind: 'paid'; order: Order }
  | { kind: 'retry'; order: Order; message: CheckoutMessage; blocking: boolean }
  | { kind: 'closed'; order: Order; message: CheckoutMessage };

interface Situation {
  record: CheckoutRecord;
  quoteId?: string;
  quote?: StoredQuote;
  /** This checkout's order for the current quote (live one preferred). */
  order?: Order;
  /** A live order on the same quote that belongs to another door or checkout. */
  foreign?: Order;
}

export function createCheckoutService(deps: DoorDeps): CheckoutService {
  const { service, config, store } = deps;
  const checkouts = store.collection<CheckoutRecord>(CHECKOUT_COLLECTION, {
    prunable: (record, ctx) => {
      const order = record.orderId ? ctx.order(record.orderId) : undefined;
      if (order && !IS_TERMINAL[order.status]) return false;
      const age = ctx.now.getTime() - Date.parse(record.updatedAt);
      if (order && (order.status === 'paid' || order.status === 'refunded')) return age > PAID_RETENTION_MS;
      if (!order && record.attempts > 0) return age > ORPHANED_ATTEMPT_RETENTION_MS;
      if (!record.orderId && record.attempts === 0) {
        // Never started paying: useless once its quote is gone or long expired (frees the caps early).
        const quoteId = quoteIdOf(record);
        const quote = quoteId ? store.getQuote(quoteId) : undefined;
        if (!quote || Date.parse(quote.expiresAt) + UNSTARTED_AFTER_QUOTE_MS < ctx.now.getTime()) return true;
      }
      return age > NEVER_PAID_RETENTION_MS;
    },
  });

  async function situate(record: CheckoutRecord): Promise<Situation> {
    const quoteId = quoteIdOf(record);
    if (!quoteId) return { record };
    const quote = await service.getQuote(quoteId);
    const live = await service.getLiveOrderForQuote(quoteId);
    if (live && live.checkoutId === record.id) return { record, quoteId, quote, order: live };
    const last = record.orderId ? await service.getOrder(record.orderId) : undefined;
    return { record, quoteId, quote, order: last && last.quoteId === quoteId ? last : undefined, foreign: live };
  }

  function render(s: Situation, extra: CheckoutMessage[] = []): CheckoutView {
    const { record, quote, order } = s;
    const graph = deps.getGraph();
    const now = deps.now().getTime();
    const disposition = disposeOrder(order);
    const quoteView: CheckoutQuoteView | undefined = quote && {
      id: quote.id,
      offering: quote.offering,
      title: graph.offerings[quote.offering]?.name ?? quote.offering,
      expiresAt: quote.expiresAt,
      lines: quote.quote.lines,
      subtotalCents: quote.quote.subtotalCents,
      taxCents: quote.quote.taxCents,
      totalCents: quote.quote.totalCents,
    };
    const quoteLive = quote !== undefined && Date.parse(quote.expiresAt) > now;

    const messages: CheckoutMessage[] = [];
    let status: CheckoutStatus;
    let expiresAt: string | undefined;
    let continueUrl: string | undefined;

    if (record.canceled) {
      status = 'canceled';
    } else if (disposition.kind === 'paid') {
      status = 'completed';
    } else if (disposition.kind === 'live') {
      status = 'complete_in_progress';
      const live = disposition.order;
      expiresAt = live.approvalDeadline ?? quote?.expiresAt;
      messages.push(
        live.status === 'awaiting_approval' && live.approvalDeadline
          ? {
              type: 'info',
              code: 'awaiting_approval',
              content:
                `Payment authorized; waiting for the business to approve (by ${live.approvalDeadline}). ` +
                'The card is charged only if the business approves by then; otherwise the hold is released. Poll this checkout for the outcome.',
            }
          : { type: 'info', code: 'payment_in_progress', content: 'Payment is being processed. Poll this checkout for the outcome.' },
      );
    } else if (disposition.kind === 'closed') {
      status = 'canceled';
      messages.push(disposition.message);
    } else if (disposition.kind === 'retry' && record.attempts >= MAX_COMPLETE_ATTEMPTS) {
      status = 'canceled';
      messages.push(disposition.message, TOO_MANY_ATTEMPTS);
    } else {
      let blocked = false;
      for (const problem of itemProblems(record, s.quoteId, quote, now)) {
        messages.push(problem);
        blocked = true;
      }
      if (!blocked && s.foreign) {
        messages.push(err('quote_in_use', 'quote', 'This quote is already being paid through another checkout or payment link. Scope again for a new quote.'));
        blocked = true;
      }
      if (!blocked && config.confirmation === 'owner_approves' && !record.buyer?.email) {
        messages.push(
          err('field_required', 'buyer_email', 'A buyer email is required (the business confirms the booking by email after approving it). Set it when creating or updating the checkout, then complete.'),
        );
        blocked = true;
      }
      if (disposition.kind === 'retry') {
        messages.push(disposition.message);
        blocked ||= disposition.blocking;
      }
      status = blocked ? 'incomplete' : 'ready_for_complete';
      if (quoteLive) expiresAt = quote.expiresAt;
      // Never hand out the raw handoff template: only the quote pay page or the business website.
      continueUrl =
        status === 'ready_for_complete' && quote
          ? `${config.publicUrl}/quotes/${encodeURIComponent(quote.id)}/pay`
          : (graph.business.website ?? config.publicUrl);
    }

    const totals = quoteView
      ? { subtotalCents: quoteView.subtotalCents, taxCents: quoteView.taxCents, totalCents: quoteView.totalCents }
      : { subtotalCents: 0, taxCents: 0, totalCents: 0 };
    const visibleOrder = disposition.kind === 'none' || disposition.kind === 'retry' ? undefined : disposition.order;
    return {
      id: record.id,
      door: record.door,
      status,
      currency: (quote?.quote.currency ?? graph.business.currency).toUpperCase(),
      lineItems: record.lineItems.map((item, index) => {
        const isQuote = index === 0 && quoteView !== undefined && item.id === quoteView.id;
        return {
          id: `li_${index + 1}`,
          itemId: item.id,
          title: isQuote ? quoteView.title : 'Unrecognized item',
          quantity: item.quantity,
          amountCents: isQuote ? quoteView.subtotalCents : 0,
        };
      }),
      quote: quoteView,
      totals,
      buyer: record.buyer,
      messages: [...extra, ...messages],
      expiresAt,
      continueUrl,
      order: visibleOrder && {
        id: visibleOrder.id,
        status: visibleOrder.status,
        statusReason: visibleOrder.statusReason,
        approvalDeadline: visibleOrder.approvalDeadline,
        permalinkUrl: `${config.publicUrl}/orders/${encodeURIComponent(visibleOrder.id)}`,
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function owned(owner: CheckoutOwner, id: string): CheckoutRecord | undefined {
    const record = checkouts.get(id);
    if (!record) return undefined;
    const door = owner === 'ucp' ? 'ucp' : owner.door;
    if (record.door !== door) return undefined;
    // ACP checkouts are bound to the bearer that created them; any other bearer sees nothing.
    const principal = owner === 'ucp' ? undefined : owner.principal;
    return principal === undefined || record.principal === principal ? record : undefined;
  }

  async function save(record: CheckoutRecord, mutate: (draft: CheckoutRecord) => void): Promise<CheckoutRecord> {
    const updatedAt = deps.now().toISOString();
    const result = await checkouts.update(record.id, record.version, (draft) => {
      mutate(draft);
      draft.updatedAt = updatedAt;
    });
    // Every mutation holds the checkout lock, so a conflict means a broken invariant.
    if (!result.ok) throw new Error(`checkout ${record.id} write failed: ${result.reason}`);
    return result.value;
  }

  const withCheckout = <T>(id: string, fn: () => Promise<T>): Promise<T> => store.locks.withLock(`checkout:${id}`, fn);

  /** Every line-item id a quote id, the first quote known and live: its id, or the refusal (nothing stored). */
  async function admissibleQuote(lineItems: LineItemInput[]): Promise<{ ok: true; quoteId: string } | CheckoutRefusal> {
    const first = lineItems[0];
    if (!first || !lineItems.every((item) => isId('qt', item.id))) {
      return refuse('invalid_items', lineItems.length === 1 ? QUOTE_REQUIRED : INVALID_LINE_ITEMS);
    }
    const quote = await service.getQuote(first.id);
    if (!quote) return refuse('invalid_items', QUOTE_REQUIRED);
    if (Date.parse(quote.expiresAt) <= deps.now().getTime()) return refuse('invalid_items', EXPIRED_QUOTE);
    return { ok: true, quoteId: first.id };
  }

  /**
   * Room for one more checkout on `quoteId`: a new one for `owner` (`moving` undefined, also
   * under the owner's open-checkout budget: anonymous UCP, or one ACP bearer) or the checkout
   * `moving` switching onto this quote. Admission lock held.
   */
  function capacityRefusal(quoteId: string, owner: CheckoutOwner, moving?: string): CheckoutRefusal | undefined {
    const principal = owner === 'ucp' ? undefined : owner.principal;
    let onQuote = 0;
    let open = 0;
    for (const record of checkouts.list()) {
      if (record.id === moving) continue;
      if (quoteIdOf(record) === quoteId) onQuote += 1;
      if (moving !== undefined || record.door !== (principal === undefined ? 'ucp' : 'acp') || record.principal !== principal) continue;
      const orderStatus = record.orderId ? store.getOrder(record.orderId)?.status : undefined;
      if (orderStatus !== 'paid' && orderStatus !== 'refunded') open += 1;
    }
    if (onQuote >= MAX_CHECKOUTS_PER_QUOTE) return refuse('quote_busy', TOO_MANY_CHECKOUTS);
    if (principal === undefined && open >= MAX_OPEN_UCP_CHECKOUTS) return refuse('full', CHECKOUTS_FULL);
    if (principal !== undefined && open >= MAX_OPEN_ACP_CHECKOUTS_PER_BEARER) return refuse('full', ACP_CHECKOUTS_FULL);
    return undefined;
  }

  return {
    async create(owner, input) {
      if (malformedEmail(input.buyer)) return refuse('invalid_buyer', INVALID_BUYER_EMAIL);
      const admissible = await admissibleQuote(input.lineItems);
      if (!admissible.ok) return admissible;
      // Cap checks and the writes they admit are serialized (innermost lock: nothing is taken under it).
      const stored = await store.locks.withLock(ADMISSION_LOCK, async (): Promise<{ ok: true; record: CheckoutRecord } | CheckoutRefusal> => {
        const refusal = capacityRefusal(admissible.quoteId, owner);
        if (refusal) return refusal;
        const createdAt = deps.now().toISOString();
        const record = await checkouts.put({
          id: newId('chk'),
          door: owner === 'ucp' ? 'ucp' : 'acp',
          ...(owner === 'ucp' ? {} : { principal: owner.principal }),
          lineItems: input.lineItems.map(({ id, quantity }) => ({ id, quantity })),
          buyer: cleanBuyer(input.buyer),
          attempts: 0,
          canceled: false,
          createdAt,
          updatedAt: createdAt,
          version: 0,
        });
        return { ok: true, record };
      });
      if (!stored.ok) return stored;
      return { ok: true, view: render(await situate(stored.record)) };
    },

    async get(owner, id) {
      const record = owned(owner, id);
      return record && render(await situate(record));
    },

    update(owner, id, patch) {
      return withCheckout(id, async (): Promise<CheckoutResult | undefined> => {
        const record = owned(owner, id);
        if (!record) return undefined;
        if (malformedEmail(patch.buyer)) return refuse('invalid_buyer', INVALID_BUYER_EMAIL);
        const s = await situate(record);
        if (record.canceled) return { ok: true, view: render(s, [CHECKOUT_CANCELED]) };
        const kind = disposeOrder(s.order).kind;
        if (kind === 'live' || kind === 'paid') {
          return { ok: true, view: render(s, [err('checkout_locked', undefined, 'This checkout has a payment in progress or completed and can no longer be changed.')]) };
        }
        const lineItems = patch.lineItems?.map(({ id: itemId, quantity }) => ({ id: itemId, quantity }));
        let quoteId = s.quoteId;
        if (lineItems) {
          const admissible = await admissibleQuote(lineItems);
          if (!admissible.ok) return admissible;
          quoteId = admissible.quoteId;
        }
        const next = await store.locks.withLock(ADMISSION_LOCK, async (): Promise<{ ok: true; record: CheckoutRecord } | CheckoutRefusal> => {
          if (quoteId !== undefined && quoteId !== s.quoteId) {
            const refusal = capacityRefusal(quoteId, owner, record.id);
            if (refusal) return refusal;
          }
          const saved = await save(record, (draft) => {
            if (lineItems) draft.lineItems = lineItems;
            if (patch.buyer) draft.buyer = cleanBuyer(patch.buyer);
            // A different quote starts fresh: the previous order's outcome no longer applies.
            if (quoteIdOf(draft) !== s.quoteId) {
              delete draft.orderId;
              delete draft.orderEvents;
            }
          });
          return { ok: true, record: saved };
        });
        if (!next.ok) return next;
        return { ok: true, view: render(await situate(next.record)) };
      });
    },

    complete(owner, id, input) {
      return withCheckout(id, async () => {
        let record = owned(owner, id);
        if (!record) return undefined;
        let s = await situate(record);
        if (record.canceled) return render(s, [CHECKOUT_CANCELED]);
        let disposition = disposeOrder(s.order);
        if (input.buyer && (disposition.kind === 'none' || disposition.kind === 'retry')) {
          // A malformed email is refused, not dropped: nothing is saved and no payment starts.
          if (malformedEmail(input.buyer)) return render(s, [INVALID_BUYER_EMAIL]);
          const buyer = input.buyer;
          record = await save(record, (draft) => {
            draft.buyer = cleanBuyer(buyer);
          });
          s = await situate(record);
          disposition = disposeOrder(s.order);
        }
        // An order still `authorizing` is resumed (same token ⇒ same Stripe idempotency key);
        // any other live or finished order makes complete a read.
        const resuming = disposition.kind === 'live' && disposition.order.status === 'authorizing';
        if (!resuming && (disposition.kind === 'live' || disposition.kind === 'paid')) return render(s);
        const current = render(s);
        if (!resuming && current.status !== 'ready_for_complete') return current;
        if (!input.credential.ok) {
          return render(s, [
            err(
              'unsupported_instrument',
              'payment',
              `${input.credential.reason} Pay with a Stripe shared payment token (handler stripe_payments, credential type stripe_payment_token for UCP or spt for ACP), or open continue_url to pay by card in a browser.`,
            ),
          ]);
        }
        const quoteId = s.quoteId;
        if (!quoteId) return current;
        let attemptBumped = false;
        if (!resuming) {
          if (record.attempts >= MAX_COMPLETE_ATTEMPTS) return render(s, [TOO_MANY_ATTEMPTS]);
          record = await save(record, (draft) => {
            draft.attempts += 1;
          });
          attemptBumped = true;
        }
        const result = await service.payWithSpt({
          quoteId,
          door: owner === 'ucp' ? 'ucp' : 'acp',
          spt: input.credential.spt,
          buyer: record.buyer,
          checkoutId: record.id,
        });
        if (!result.ok && result.error === 'payment_pending') {
          // Outcome unknown: not an attempt, nothing final to show. The retry resumes the
          // same order with the same credential (same Stripe idempotency key).
          if (attemptBumped) {
            record = await save(record, (draft) => {
              draft.attempts -= 1;
            });
          }
          const view = render(await situate(record), [PAYMENT_PENDING]);
          view.paymentPending = true;
          return view;
        }
        if (result.ok && record.orderId !== result.value.id) {
          const orderId = result.value.id;
          record = await save(record, (draft) => {
            draft.orderId = orderId;
          });
        }
        const view = render(await situate(record), result.ok ? [] : [serviceErrorMessage(result.error, result.message)]);
        // A payment was started or resumed: the complete outcome worth replaying for this key.
        view.stateChanged = true;
        return view;
      });
    },

    cancel(owner, id) {
      return withCheckout(id, async () => {
        const record = owned(owner, id);
        if (!record) return undefined;
        const s = await situate(record);
        if (record.canceled) return render(s);
        const disposition = disposeOrder(s.order);
        if (disposition.kind === 'paid') {
          return render(s, [err('checkout_completed', undefined, 'This checkout is already paid and cannot be canceled. Contact the business for changes or refunds.', 'unrecoverable')]);
        }
        if (disposition.kind !== 'live') {
          const next = await save(record, (draft) => {
            draft.canceled = true;
          });
          const view = render(await situate(next));
          view.stateChanged = true;
          return view;
        }
        if (disposition.order.status !== 'awaiting_approval') {
          return render(s, [err('payment_in_progress', undefined, `Payment is being processed (${disposition.order.status}); retry cancel shortly.`)]);
        }
        const result = await service.cancel(disposition.order.id);
        if (!result.ok) return render(await situate(record), [serviceErrorMessage(result.error, result.message)]);
        const view = render(await situate(record));
        view.stateChanged = true;
        return view;
      });
    },

    list(door) {
      return checkouts.list().filter((record) => record.door === door);
    },

    getOrderEvents(id) {
      return checkouts.get(id)?.orderEvents;
    },

    async setOrderEvents(id, next) {
      await withCheckout(id, async () => {
        const record = checkouts.get(id);
        if (!record) return;
        const result = await checkouts.update(record.id, record.version, (draft) => {
          draft.orderEvents = next;
        });
        // Delivery holds the same lock as every other checkout mutation.
        if (!result.ok) throw new Error(`checkout ${id} write failed: ${result.reason}`);
      });
    },
  };
}

// ─── Derivation helpers ──────────────────────────────────────────────────────

/** The quote id a checkout wraps: its first line item, when well-formed. */
function quoteIdOf(record: CheckoutRecord): string | undefined {
  const first = record.lineItems[0];
  return first && isId('qt', first.id) ? first.id : undefined;
}

const SCOPE_FIRST =
  'Scope this request first: call scope_offering (MCP) or POST /api/offerings/{id}/scope, then pass the returned quote id as the item id.';

/** Lock serializing checkout cap checks with the writes they admit. */
const ADMISSION_LOCK = 'checkout-admission';

function itemProblems(record: CheckoutRecord, quoteId: string | undefined, quote: StoredQuote | undefined, now: number): CheckoutMessage[] {
  if (record.lineItems.length !== 1) return [INVALID_LINE_ITEMS];
  if (!quoteId || !quote) return [QUOTE_REQUIRED];
  if (Date.parse(quote.expiresAt) <= now) return [EXPIRED_QUOTE];
  const quantity = record.lineItems[0]?.quantity;
  if (quantity !== 1) {
    return [err('invalid_quantity', 'quantity', 'The quote line item must have quantity 1; quantities are part of the scoped request.')];
  }
  return [];
}

function refuse(reason: CheckoutRefusalReason, message: CheckoutMessage): CheckoutRefusal {
  return { ok: false, reason, message };
}

/** A buyer whose email is present but not address-shaped: refused rather than silently dropped. */
function malformedEmail(buyer: Buyer | undefined): boolean {
  return buyer?.email !== undefined && buyer.email.trim() !== '' && !isEmailShaped(buyer.email);
}

function disposeOrder(order: Order | undefined): Disposition {
  if (!order) return { kind: 'none' };
  switch (order.status) {
    case 'paid':
    case 'refunded':
      return { kind: 'paid', order };
    case 'awaiting_payment':
    case 'authorizing':
    case 'awaiting_approval':
    case 'capturing':
    case 'voiding':
      return { kind: 'live', order };
    case 'payment_failed':
      return {
        kind: 'retry',
        order,
        blocking: false,
        message: err(
          'payment_declined',
          'payment',
          order.statusReason === 'requires_3ds'
            ? 'The card requires authentication (3-D Secure), which this checkout cannot perform. Use another payment token, or open continue_url to pay in a browser.'
            : 'The payment was declined. Complete again with another payment token, or open continue_url to pay in a browser.',
        ),
      };
    case 'canceled':
      if (order.statusReason === 'requote_required') {
        return { kind: 'retry', order, blocking: true, message: PRICE_CHANGED };
      }
      if (order.statusReason === 'date_too_soon') {
        return {
          kind: 'retry',
          order,
          blocking: true,
          message: err('date_too_soon', 'quote', `The requested date is too soon for the business to confirm in time; the card hold was released. ${SCOPE_FIRST}`),
        };
      }
      return { kind: 'closed', order, message: closed('The order was canceled and the card hold released.') };
    case 'rejected':
      return { kind: 'closed', order, message: closed('The business declined this request; the card hold was released and nothing was charged.') };
    case 'expired':
      return { kind: 'closed', order, message: closed('The business did not confirm in time; the card hold was released and nothing was charged.') };
  }
}

function serviceErrorMessage(error: ServiceError, detail: string): CheckoutMessage {
  switch (error) {
    case 'quote_not_found':
      return QUOTE_REQUIRED;
    case 'quote_expired':
      return EXPIRED_QUOTE;
    case 'quote_in_use':
      return err('quote_in_use', 'quote', 'This quote is already being paid through another checkout or payment link. Scope again for a new quote.');
    case 'requote_required':
      return PRICE_CHANGED;
    case 'amount_too_small':
      return err('amount_too_small', 'quote', 'The quote total is below the minimum card payment; it cannot be paid online.', 'unrecoverable');
    case 'buyer_email_required':
      return err('field_required', 'buyer_email', 'A buyer email is required (the business confirms the booking by email after approving it). Set it when creating or updating the checkout, then complete.');
    case 'payment_declined':
      return err('payment_declined', 'payment', `The payment was declined: ${detail} Complete again with another payment token.`);
    case 'different_credential':
      return err('different_credential', 'payment', 'A payment with a different token is still being processed for this checkout; retry with the same token or wait for it to finish.');
    case 'payment_pending':
      // `complete` handles this before mapping; kept exhaustive for any other surface.
      return PAYMENT_PENDING;
    case 'too_many_attempts':
      return TOO_MANY_ATTEMPTS;
    case 'order_not_found':
    case 'invalid_state':
    case 'door_unavailable':
      return err('service_error', undefined, detail);
  }
}

function err(code: CheckoutMessageCode, field: CheckoutField | undefined, content: string, severity: 'recoverable' | 'unrecoverable' = 'recoverable'): CheckoutMessage {
  return field ? { type: 'error', code, severity, field, content } : { type: 'error', code, severity, content };
}

function closed(content: string): CheckoutMessage {
  return { type: 'info', code: 'order_closed', content };
}

/** Shared, exact-wording messages (identical across every operation that emits them). */
const PRICE_CHANGED: CheckoutMessage = err('price_changed', 'quote', `The price or availability changed since this quote was made. ${SCOPE_FIRST}`);

const QUOTE_REQUIRED: CheckoutMessage = err('quote_required', 'quote', SCOPE_FIRST);

const EXPIRED_QUOTE: CheckoutMessage = err('quote_expired', 'quote', `This quote has expired. ${SCOPE_FIRST}`);

const INVALID_LINE_ITEMS: CheckoutMessage = err('invalid_line_items', 'line_items', `A checkout holds exactly one line item: the quote. ${SCOPE_FIRST}`);

const INVALID_BUYER_EMAIL: CheckoutMessage = err(
  'invalid_buyer_email',
  'buyer_email',
  'The buyer email is not a valid email address (expected name@example.com); nothing was changed. Send a corrected email.',
);

const TOO_MANY_CHECKOUTS: CheckoutMessage = err(
  'too_many_checkouts',
  'quote',
  `This quote already has ${String(MAX_CHECKOUTS_PER_QUOTE)} checkouts; nothing was saved. Continue one of them, or scope again for a new quote.`,
);

const CHECKOUTS_FULL: CheckoutMessage = err(
  'checkouts_full',
  undefined,
  'The business has too many open checkouts right now; nothing was created. Retry in a few minutes.',
);

const ACP_CHECKOUTS_FULL: CheckoutMessage = err(
  'checkouts_full',
  undefined,
  `This platform already has ${String(MAX_OPEN_ACP_CHECKOUTS_PER_BEARER)} open checkouts with this business; nothing was created. Complete or cancel some, or retry later.`,
);

const TOO_MANY_ATTEMPTS: CheckoutMessage = err('too_many_attempts', 'payment', 'Too many payment attempts for this checkout. Scope again for a new quote.', 'unrecoverable');

const CHECKOUT_CANCELED: CheckoutMessage = err('checkout_canceled', undefined, 'This checkout is canceled. Scope again and create a new checkout.', 'unrecoverable');

const PAYMENT_PENDING: CheckoutMessage = {
  type: 'info',
  code: 'payment_pending',
  content:
    'The payment outcome is not yet known; do not report a decline and do not pay again. ' +
    'Retry complete with the SAME payment token (same idempotency key): it resumes this payment and does not count as a new attempt.',
};
