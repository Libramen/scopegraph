/**
 * ACP 2026-04-17 rendering: discovery document, CheckoutSession responses, order payloads for
 * webhooks, and the message/status mapping from the protocol-neutral `CheckoutView`.
 *
 * Schema source (vendored at `./schema.acp-2026-04-17.json` for tests):
 * https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/spec/2026-04-17/json-schema/schema.agentic_checkout.json
 * Reference: https://www.agenticcommerce.dev/docs/reference/checkout
 */
import type { Business } from '../../graph/types.js';
import type { Buyer, OrderStatus } from '../types.js';
import type { CheckoutField, CheckoutMessage, CheckoutMessageCode, CheckoutRefusal, CheckoutView } from '../checkout/index.js';

export const ACP_VERSION = '2026-04-17';
export const ACP_SUPPORTED_VERSIONS = [ACP_VERSION];

export const ACP_HANDLER = {
  id: 'card_tokenized',
  name: 'dev.acp.tokenized.card',
  display_name: 'Card (Stripe shared payment token)',
  version: '2026-01-22',
  spec: 'https://acp.dev/handlers/tokenized.card',
  requires_delegate_payment: true,
  requires_pci_compliance: false,
  psp: 'stripe',
  config_schema: 'https://acp.dev/schemas/handlers/tokenized.card/config.json',
  instrument_schemas: ['https://acp.dev/schemas/handlers/tokenized.card/instrument.json'],
};

export interface AcpContext {
  business: Business;
  publicUrl: string;
  livemode: boolean;
  profileId?: string;
}

/** ACP MessageError codes are a closed enum; every neutral code must land somewhere. */
const MESSAGE_CODE: Record<CheckoutMessageCode, string> = {
  quote_required: 'missing',
  quote_expired: 'expired',
  quote_in_use: 'conflict',
  amount_too_small: 'minimum_not_met',
  invalid_line_items: 'invalid',
  invalid_quantity: 'invalid',
  invalid_buyer_email: 'invalid',
  field_required: 'missing',
  payment_declined: 'payment_declined',
  price_changed: 'invalid',
  date_too_soon: 'invalid',
  unsupported_instrument: 'unsupported',
  different_credential: 'conflict',
  too_many_attempts: 'rate_limited',
  checkout_locked: 'conflict',
  payment_in_progress: 'conflict',
  // Info-only in practice (`payment_pending` rides MessageInfo): if ever mapped to an error,
  // "conflict" (a payment is already being processed for this checkout) is the honest bucket.
  payment_pending: 'conflict',
  awaiting_approval: 'approval_required',
  order_closed: 'conflict',
  checkout_completed: 'conflict',
  checkout_canceled: 'conflict',
  // Refusals only (protocol `Error`, never a session message); mapped for exhaustiveness.
  too_many_checkouts: 'conflict',
  checkouts_full: 'rate_limited',
  service_error: 'unsupported',
};

/** RFC 9535 JSONPath into the ACP request the agent sent. */
function acpParam(field: CheckoutField | undefined): string | undefined {
  switch (field) {
    case 'line_items':
    case 'quote':
      return '$.line_items[0].id';
    case 'quantity':
      return '$.line_items[0].quantity';
    case 'buyer_email':
      return '$.buyer.email';
    case 'payment':
      return '$.payment_data.instrument.credential.token';
  }
  return undefined;
}

function cents(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function safeUrl(url: string | undefined, fallback: string): string {
  return url && /^https?:\/\//.test(url) ? url : fallback;
}

/** `GET /.well-known/acp.json`. */
export function buildAcpDiscovery(ctx: AcpContext) {
  return {
    protocol: { name: 'acp', version: ACP_VERSION, supported_versions: ACP_SUPPORTED_VERSIONS },
    api_base_url: `${ctx.publicUrl}/acp`,
    transports: ['rest'],
    capabilities: { services: ['checkout'] },
  };
}

function handlerConfig(ctx: AcpContext): Record<string, unknown> {
  const config: Record<string, unknown> = {
    psp: 'stripe',
    environment: ctx.livemode ? 'production' : 'test',
    accepted_brands: ['visa', 'mastercard', 'amex', 'discover'],
  };
  if (ctx.profileId) config.business_profile = ctx.profileId;
  return config;
}

function mapBuyer(buyer: Buyer | undefined) {
  if (!buyer) return undefined;
  const out: { full_name?: string; email?: string; phone_number?: string } = {};
  if (buyer.name) out.full_name = buyer.name;
  if (buyer.email) out.email = buyer.email;
  if (buyer.phone) out.phone_number = buyer.phone;
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapMessage(message: CheckoutMessage) {
  if (message.type === 'error') {
    return {
      type: 'error' as const,
      code: MESSAGE_CODE[message.code],
      severity: message.severity === 'unrecoverable' ? 'high' : 'medium',
      resolution: message.severity === 'unrecoverable' ? ('requires_buyer_review' as const) : ('recoverable' as const),
      content_type: 'plain' as const,
      content: message.content,
      ...(message.field ? { param: acpParam(message.field) } : {}),
    };
  }
  return {
    type: 'info' as const,
    severity: 'info' as const,
    content_type: 'plain' as const,
    content: message.content,
    // A pending payment is agent-recoverable: retry complete with the same token.
    ...(message.code === 'payment_pending' ? { resolution: 'recoverable' as const, param: acpParam('payment') } : {}),
  };
}

/** Order status mapping incl. `manual_review` (owner approval gate). */
export function acpOrderStatus(status: OrderStatus): string {
  switch (status) {
    case 'awaiting_payment':
    case 'authorizing':
    case 'awaiting_approval':
      return 'manual_review';
    case 'capturing':
    case 'voiding':
      return 'processing';
    case 'paid':
      return 'confirmed';
    case 'rejected':
    case 'expired':
    case 'canceled':
    case 'payment_failed':
    case 'refunded':
      return 'canceled';
  }
}

function orderPayload(view: CheckoutView, currency: string) {
  const order = view.order!;
  const quantity = { ordered: 1, current: 1 };
  return {
    type: 'order' as const,
    id: order.id,
    checkout_session_id: view.id,
    permalink_url: order.permalinkUrl,
    status: acpOrderStatus(order.status),
    line_items: [
      {
        id: view.lineItems[0]?.id ?? 'li_1',
        title: view.lineItems[0]?.title ?? ctxTitle(view),
        product_id: view.quote?.offering,
        quantity,
        unit_price: view.totals.subtotalCents,
        subtotal: view.totals.subtotalCents,
      },
    ],
    totals: acpTotals(view, currency),
    confirmation: { confirmation_email_sent: false },
  };
}

function ctxTitle(view: CheckoutView): string {
  return view.quote?.title ?? view.lineItems[0]?.title ?? 'Checkout';
}

function acpTotals(view: CheckoutView, currency: string) {
  const totals: Array<{ type: string; amount: number; display_text: string }> = [
    { type: 'subtotal', amount: view.totals.subtotalCents, display_text: cents(view.totals.subtotalCents, currency) },
  ];
  if (view.totals.taxCents !== 0) {
    totals.push({ type: 'tax', amount: view.totals.taxCents, display_text: cents(view.totals.taxCents, currency) });
  }
  totals.push({ type: 'total', amount: view.totals.totalCents, display_text: cents(view.totals.totalCents, currency) });
  return totals;
}

/**
 * ACP CheckoutSession (the `CheckoutSessionWithOrder` shape once an order exists).
 * `pending_approval` (order `manual_review`) and `completed` (order `confirmed`) carry `order`.
 */
export function renderAcpSession(view: CheckoutView, ctx: AcpContext) {
  const currency = view.currency.toLowerCase();
  const orderLive = view.status === 'complete_in_progress' && view.order?.status === 'awaiting_approval';
  const withOrder = orderLive || view.status === 'completed';
  return {
    id: view.id,
    protocol: { version: ACP_VERSION },
    capabilities: {
      payment: { handlers: [{ ...ACP_HANDLER, config: handlerConfig(ctx) }] },
      interventions: { supported: [], required: [], enforcement: 'optional' },
    },
    ...(view.buyer ? { buyer: mapBuyer(view.buyer) } : {}),
    status: acpSessionStatus(view),
    currency,
    line_items: view.lineItems.map((item) => ({
      id: item.id,
      item: { id: item.itemId },
      // The schema requires quantity ≥ 1; an invalid request quantity is reported by message.
      quantity: Math.max(1, item.quantity),
      name: item.title,
      unit_amount: item.amountCents,
      totals: [
        { type: 'subtotal', amount: item.amountCents, display_text: cents(item.amountCents, currency) },
        { type: 'total', amount: item.amountCents, display_text: cents(item.amountCents, currency) },
      ],
    })),
    fulfillment_options: [],
    totals: acpTotals(view, currency),
    messages: view.messages.map(mapMessage),
    links: [{ type: 'about_us', title: ctx.business.name, url: safeUrl(ctx.business.website, ctx.publicUrl) }],
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    ...(view.expiresAt ? { expires_at: view.expiresAt } : {}),
    ...(view.continueUrl ? { continue_url: view.continueUrl } : {}),
    ...(view.quote ? { quote_id: view.quote.id, quote_expires_at: view.quote.expiresAt } : {}),
    ...(withOrder && view.order ? { order: orderPayload(view, currency) } : {}),
  };
}

/** Neutral → ACP checkout-session status. */
function acpSessionStatus(view: CheckoutView): string {
  switch (view.status) {
    case 'incomplete':
      return 'not_ready_for_payment';
    case 'ready_for_complete':
      return 'ready_for_payment';
    case 'complete_in_progress':
      return view.order?.status === 'awaiting_approval' ? 'pending_approval' : 'complete_in_progress';
    case 'completed':
    case 'canceled':
      return view.status;
  }
}

/** Protocol-level error body (ACP `Error`): 4xx/5xx when no valid session can be returned. */
export function acpError(type: 'invalid_request' | 'processing_error' | 'service_unavailable', code: string, message: string, extra?: { param?: string; supportedVersions?: string[] }) {
  return {
    type,
    code,
    message,
    ...(extra?.param ? { param: extra.param } : {}),
    ...(extra?.supportedVersions ? { supported_versions: extra.supportedVersions } : {}),
  };
}

/** A refused create/update (nothing stored): protocol `Error` carrying the checkout guidance and its JSONPath. */
export function acpRefusalError(refusal: CheckoutRefusal) {
  const { message } = refusal;
  return acpError(refusal.reason === 'full' ? 'service_unavailable' : 'invalid_request', message.code, message.content, { param: acpParam(message.field) });
}
