/**
 * Payments contract — the types every payment module shares (orders, quotes,
 * the Stripe gateway, doors). See docs/payments.md for the behaviour.
 *
 *   scope → Quote (qt_…) → Order (ord_…, one door) → Stripe → paid | rejected | …
 */
import type { Graph, Value } from '../graph/types.js';
import type { PaymentsStore } from './store/index.js';
import type { Quote } from '../engine/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { Router } from 'express';

export type Door = 'link' | 'ucp' | 'acp' | 'mpp';
type Confirmation = 'owner_approves' | 'instant';

export interface ScopedRequest {
  answers: Record<string, Value>;
  selections: Record<string, string[]>;
  date?: string;
}

/** A payable, server-frozen qualified quote. Entry point for every door. */
export interface StoredQuote {
  id: string; // qt_…
  offering: string;
  request: ScopedRequest;
  quote: Quote;
  createdAt: string;
  expiresAt: string;
  /** Who asked for it (the rate-limit key, e.g. client IP): per-client quota and dedupe. Never shown to agents. */
  client?: string;
}

export type OrderStatus =
  | 'awaiting_payment' // link door: Checkout Session open, customer hasn't paid
  | 'authorizing' // internal: PaymentIntent create in flight
  | 'awaiting_approval' // card held; owner must approve by approvalDeadline
  | 'capturing' // internal: capture in flight
  | 'voiding' // internal: cancel of a held PaymentIntent in flight
  | 'paid'
  | 'rejected'
  | 'expired'
  | 'canceled'
  | 'payment_failed'
  | 'refunded';

/** Exhaustive: adding a status forces a decision here. */
export const IS_TERMINAL: Record<OrderStatus, boolean> = {
  awaiting_payment: false,
  authorizing: false,
  awaiting_approval: false,
  capturing: false,
  voiding: false,
  paid: true,
  rejected: true,
  expired: true,
  canceled: true,
  payment_failed: true,
  refunded: true,
};

export interface Buyer {
  name?: string;
  email?: string;
  phone?: string;
}

export type HookName = 'onApprovalNeeded' | 'onPaid' | 'onClosed';

export interface Order {
  id: string; // ord_…
  quoteId: string;
  offering: string;
  request: ScopedRequest;
  quote: Quote; // frozen copy of the quote
  confirmation: Confirmation; // frozen at creation
  door: Door; // bound at creation; immutable
  checkoutId?: string; // chk_… for ucp/acp
  buyer?: Buyer;
  /** Copied from the quote it was started from (per-client quota). Never shown to agents. */
  client?: string;
  createdAt: string;
  approvalDeadline?: string;
  stripe: {
    paymentIntentId?: string;
    checkoutSessionId?: string;
    checkoutSessionExpiresAt?: string;
    checkoutUrl?: string;
    tokenFingerprint?: string;
    authorizeAttemptAt?: string;
  };
  voidOutcome?: 'rejected' | 'expired' | 'canceled';
  status: OrderStatus;
  /** Public-safe, scrubbed, ≤ 500 chars (e.g. 'requote_required', 'date_too_soon', owner's reject reason). */
  statusReason?: string;
  refundedCents?: number;
  /**
   * PaymentIntents whose void/refund (money the order must not keep) is
   * unresolved. Retried by the reconciler with backoff until Stripe shows the PI
   * released; after a bounded number of attempts it is given up with a loud log
   * but the entry stays. An order is never pruned while this is non-empty.
   */
  releases?: Array<{ paymentIntentId: string; attempts: number; nextAttemptAt: string }>;
  pendingHooks: Array<{ hook: HookName; attempts: number }>;
  lastOperation?: { op: string; result: string; at: string };
  version: number;
}

/** What agents and public pages may see: no buyer PII, no answers. */
export interface PublicOrder {
  id: string;
  offering: string;
  status: OrderStatus;
  statusReason?: string;
  confirmation: Confirmation;
  door: Door;
  quote: Quote;
  approvalDeadline?: string;
  paymentUrl?: string; // link door while awaiting_payment
  statusUrl: string; // PUBLIC_URL/orders/<id>
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface PaymentsConfig {
  confirmation: Confirmation;
  approvalWindowHours: number; // 1–96
  quoteTtlMinutes: number; // 30–240
  successUrl?: string; // may contain {order}
  cancelUrl?: string;
  publicUrl: string; // no trailing slash
  stripe: { secretKey: string; webhookSecret: string; profileId?: string; livemode: boolean };
  adminToken: string;
  signingSecret: string;
  dataDir: string;
  acp?: { bearerTokens: string[]; webhookUrl?: string; webhookSecret?: string };
  mppEnabled: boolean; // true only when MPP_ENABLED and confirmation === 'instant'
}

// ─── Stripe gateway (observations only; logic never trusts call results) ────

export interface ObservedPaymentIntent {
  id: string;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded';
  amount: number;
  currency: string; // lowercase from Stripe
  metadata: Record<string, string>;
  /** Latest charge's capture deadline, if Stripe reports one. */
  captureBefore?: string;
  amountRefunded: number;
}

export interface ObservedCheckoutSession {
  id: string;
  status: 'open' | 'complete' | 'expired';
  paymentIntentId?: string;
  url?: string;
  expiresAt: string;
  metadata: Record<string, string>;
  customer?: Buyer;
}

/** Thrown for network/timeout/5xx — outcome unknown; caller must re-observe. */
export class AmbiguousGatewayError extends Error {
  override readonly name = 'AmbiguousGatewayError';
}
/** Thrown for definitive Stripe rejections (card declined, invalid request). Message is scrubbed. */
export class DefinitiveGatewayError extends Error {
  override readonly name = 'DefinitiveGatewayError';
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface PaymentGateway {
  authorizeSpt(input: { order: Order; spt: string; fingerprint: string; receiptEmail?: string }): Promise<ObservedPaymentIntent>;
  createCheckoutSession(input: { order: Order; offeringName: string; successUrl: string; cancelUrl: string }): Promise<ObservedCheckoutSession>;
  capture(order: Order, paymentIntentId: string): Promise<void>;
  cancel(order: Order, paymentIntentId: string): Promise<void>;
  refund(order: Order, paymentIntentId: string): Promise<void>;
  retrievePaymentIntent(paymentIntentId: string): Promise<ObservedPaymentIntent>;
  retrieveCheckoutSession(sessionId: string): Promise<ObservedCheckoutSession>;
  expireCheckoutSession(sessionId: string): Promise<void>;
  findPaymentIntentsByOrder(orderId: string): Promise<ObservedPaymentIntent[]>;
  /** Verifies the signature on the raw body; returns the event or undefined when invalid. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): { type: string; objectId: string; metadata: Record<string, string> } | undefined;
}

// ─── Order service (the only way to change order state) ─────────────────────

export type ServiceError =
  | 'quote_not_found'
  | 'quote_expired'
  | 'quote_in_use'
  | 'requote_required'
  | 'amount_too_small'
  | 'order_not_found'
  | 'invalid_state'
  | 'different_credential'
  | 'buyer_email_required'
  | 'payment_declined'
  | 'too_many_attempts'
  | 'door_unavailable'
  /** Stripe outcome unknown (ambiguous); the caller must retry with the SAME credential — never report "not charged". */
  | 'payment_pending';

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError; message: string };

export interface OrderService {
  /**
   * Called by scope paths on `qualified`; undefined when not payable (below Stripe's minimum charge
   * for the currency, a non-two-decimal currency, or `client` already holds too many unstarted quotes).
   * `client` identifies the caller for per-client quota (the rate-limit key, e.g. client IP).
   */
  createQuote(offering: string, request: ScopedRequest, quote: Quote, client?: string): Promise<StoredQuote | undefined>;
  getQuote(quoteId: string): Promise<StoredQuote | undefined>;
  /** Link door: creates/reuses the link order and its Checkout Session. */
  startLinkOrder(quoteId: string): Promise<ServiceResult<{ order: PublicOrder; url: string }>>;
  /** SPT doors (ucp/acp/mpp): funnel + authorization; returns the order after observation. */
  payWithSpt(input: {
    quoteId: string;
    door: Exclude<Door, 'link'>;
    spt: string;
    buyer?: Buyer;
    checkoutId?: string;
    /** MPP: require the order to reach `paid` before returning ok. */
    requireSettled?: boolean;
  }): Promise<ServiceResult<Order>>;
  approve(orderId: string): Promise<ServiceResult<Order>>;
  reject(orderId: string, reason?: string): Promise<ServiceResult<Order>>;
  /** Buyer/agent cancel (UCP/ACP). */
  cancel(orderId: string): Promise<ServiceResult<Order>>;
  getOrder(orderId: string): Promise<Order | undefined>;
  /** Live (non-terminal or paid) order for a quote, if any. */
  getLiveOrderForQuote(quoteId: string): Promise<Order | undefined>;
  listOrders(filter?: { status?: OrderStatus }): Promise<Order[]>;
  toPublic(order: Order): PublicOrder;
  /** Webhook entry: event is a trigger; state comes from re-reading Stripe. */
  handleStripeTrigger(event: { type: string; objectId: string; metadata: Record<string, string> }): Promise<void>;
  /** One reconciler pass (sweep): processing states, expiries, link sessions, pending hooks, pruning. */
  reconcile(now?: Date): Promise<void>;
}

/** Context passed to createPayments by the server. */
export interface PaymentsDeps {
  getGraph: () => Graph;
  config: PaymentsConfig;
  gateway?: PaymentGateway; // default StripeGateway; tests pass FakeGateway
  now?: () => Date;
}

// ─── Door modules ────────────────────────────────────────────────────────────

/** What every door module receives from `setupPayments`. */
export interface DoorDeps {
  service: OrderService;
  config: PaymentsConfig;
  getGraph: () => Graph;
  store: PaymentsStore;
  now: () => Date;
}

/**
 * An MCP tool contributed by a payment module. `tool` is the MCP SDK `Tool`
 * definition (name, title, description, JSON-Schema inputSchema, annotations);
 * `call` returns a CallToolResult. The server registers these next to the
 * scoping tools (HTTP transport only; never in stdio mode).
 */
export interface PaymentMcpTool {
  tool: Tool;
  call(args: Record<string, unknown>): Promise<CallToolResult>;
}

/** Door module factory shape (each door's `index.ts` default-exports nothing; named `createXDoor`). */
export interface DoorModule {
  /** Express router mounted at the app root (routes carry their own prefixes). */
  router?: Router;
  mcpTools?: PaymentMcpTool[];
}
