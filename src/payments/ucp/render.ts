/**
 * UCP 2026-08-25 rendering: the `ucp` envelope, discovery profile, and the mapping from the
 * protocol-neutral `CheckoutView` to a UCP CheckoutResponse / ErrorResponse.
 *
 * Schema sources (validated in ucp/index.test.ts via @ucp-js/sdk):
 *   - Checkout response: https://ucp.dev/2026-08-25/schemas/shopping/checkout.json
 *   - Error response:    https://ucp.dev/2026-08-25/schemas/common/types/error_response.json
 *   - Discovery profile: https://ucp.dev/2026-08-25/specification/overview/#profile-structure
 *   - Stripe handler:    https://docs.stripe.com/agentic-commerce/protocols/ucp/stripe-payments-handler
 */
import type { Business } from '../../graph/types.js';
import type { Buyer } from '../types.js';
import type { CheckoutField, CheckoutMessage, CheckoutView } from '../checkout/index.js';

const UCP_VERSION = '2026-08-25';
const UCP_CHECKOUT_CAPABILITY = 'dev.ucp.shopping.checkout';
const UCP_SHOPPING_SERVICE = 'dev.ucp.shopping';
const STRIPE_HANDLER_NAMESPACE = 'com.stripe.payments';
export const STRIPE_HANDLER_ID = 'stripe_payments';
const STRIPE_HANDLER_VERSION = '2026-06-25';
const STRIPE_HANDLER_SPEC = 'https://docs.stripe.com/agentic-commerce/protocols/ucp/stripe-payments-handler';
const STRIPE_HANDLER_SCHEMA = 'https://ucp.stripe.com/payments/2026-06-25/schema.json';
export const STRIPE_CREDENTIAL_TYPE = 'stripe_payment_token';

export interface UcpContext {
  business: Business;
  publicUrl: string;
  livemode: boolean;
  profileId?: string;
}

/** RFC 9535 JSONPath, bracket form, pointing into the request the agent sent. */
export function fieldPath(field: CheckoutField | undefined): string | undefined {
  switch (field) {
    case 'line_items':
    case 'quote':
      return "$['line_items'][0]['item']['id']";
    case 'quantity':
      return "$['line_items'][0]['quantity']";
    case 'buyer_email':
      return "$['buyer']['email']";
    case 'payment':
      return "$['payment']['instruments'][0]['credential']['token']";
  }
  return undefined;
}

function cents(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function safeUrl(url: string | undefined, fallback: string): string {
  return url && /^https?:\/\//.test(url) ? url : fallback;
}

/** Business links: the business website (never the raw handoff template), else the public root (UCP: `links` required). */
function ucpLinks(ctx: UcpContext): Array<{ type: string; title: string; url: string }> {
  return [{ type: 'about', title: ctx.business.name, url: safeUrl(ctx.business.website, ctx.publicUrl) }];
}

function stripeHandler(ctx: UcpContext) {
  const config: Record<string, unknown> = { environment: ctx.livemode ? 'livemode' : 'testmode' };
  if (ctx.profileId) config.business_profile = ctx.profileId;
  return {
    id: STRIPE_HANDLER_ID,
    version: STRIPE_HANDLER_VERSION,
    spec: STRIPE_HANDLER_SPEC,
    schema: STRIPE_HANDLER_SCHEMA,
    available_instruments: [{ type: 'card' }],
    config,
  };
}

function envelope(ctx: UcpContext, status: 'success' | 'error') {
  return {
    version: UCP_VERSION,
    status,
    capabilities: { [UCP_CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }] },
    payment_handlers: { [STRIPE_HANDLER_NAMESPACE]: [stripeHandler(ctx)] },
  };
}

/** `GET /.well-known/ucp` — keyed registries per the 2026-08-25 profile structure. */
export function buildUcpProfile(ctx: UcpContext) {
  return {
    ucp: {
      version: UCP_VERSION,
      status: 'success',
      services: {
        [UCP_SHOPPING_SERVICE]: [
          {
            version: UCP_VERSION,
            spec: 'https://ucp.dev/2026-08-25/specification/overview/',
            transport: 'rest',
            endpoint: `${ctx.publicUrl}/ucp`,
            schema: 'https://ucp.dev/2026-08-25/services/shopping/rest.openapi.json',
          },
          {
            version: UCP_VERSION,
            spec: 'https://ucp.dev/2026-08-25/specification/overview/',
            transport: 'mcp',
            endpoint: `${ctx.publicUrl}/mcp`,
            schema: 'https://ucp.dev/2026-08-25/services/shopping/mcp.openrpc.json',
          },
        ],
      },
      capabilities: {
        [UCP_CHECKOUT_CAPABILITY]: [
          {
            version: UCP_VERSION,
            spec: 'https://ucp.dev/2026-08-25/specification/shopping/checkout',
            schema: 'https://ucp.dev/2026-08-25/schemas/shopping/checkout.json',
          },
        ],
      },
      payment_handlers: { [STRIPE_HANDLER_NAMESPACE]: [stripeHandler(ctx)] },
    },
  };
}

function mapBuyer(buyer: Buyer | undefined) {
  if (!buyer) return undefined;
  const out: { first_name?: string; email?: string; phone_number?: string } = {};
  if (buyer.name) out.first_name = buyer.name;
  if (buyer.email) out.email = buyer.email;
  if (buyer.phone) out.phone_number = buyer.phone;
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapMessage(message: CheckoutMessage) {
  if (message.type === 'error') {
    return {
      type: 'error' as const,
      code: message.code,
      severity: message.severity ?? 'recoverable',
      content_type: 'plain' as const,
      content: message.content,
      ...(message.field ? { path: fieldPath(message.field) } : {}),
    };
  }
  return {
    type: 'info' as const,
    code: message.code,
    content_type: 'plain' as const,
    content: message.content,
  };
}

/**
 * UCP checkout resource. Business outcomes ride HTTP 200 with the envelope; totals, currency
 * (ISO uppercase) and line items come from the frozen quote via the neutral view.
 */
export function renderCheckoutResponse(view: CheckoutView, ctx: UcpContext) {
  const currency = view.currency;
  const totals: Array<{ type: string; amount: number; display_text: string }> = [
    { type: 'subtotal', amount: view.totals.subtotalCents, display_text: cents(view.totals.subtotalCents, currency) },
  ];
  if (view.totals.taxCents !== 0) {
    totals.push({ type: 'tax', amount: view.totals.taxCents, display_text: cents(view.totals.taxCents, currency) });
  }
  totals.push({ type: 'total', amount: view.totals.totalCents, display_text: cents(view.totals.totalCents, currency) });

  return {
    ucp: envelope(ctx, 'success'),
    id: view.id,
    status: view.status,
    currency,
    ...(view.buyer ? { buyer: mapBuyer(view.buyer) } : {}),
    line_items: view.lineItems.map((item) => ({
      id: item.id,
      item: { id: item.itemId, title: item.title, price: item.amountCents },
      // The schema requires quantity ≥ 1; an invalid request quantity is reported by message.
      quantity: Math.max(1, item.quantity),
      totals: [{ type: 'subtotal', amount: item.amountCents, display_text: cents(item.amountCents, currency) }],
    })),
    totals,
    links: ucpLinks(ctx),
    messages: view.messages.map((message) => mapMessage(message)),
    ...(view.expiresAt ? { expires_at: view.expiresAt } : {}),
    ...(view.continueUrl ? { continue_url: view.continueUrl } : {}),
    ...(view.status === 'completed' && view.order
      ? { order: { id: view.order.id, permalink_url: view.order.permalinkUrl, label: 'order' } }
      : {}),
  };
}

/**
 * Error response for protocol-level failures (validation, unknown checkout id): HTTP 4xx with
 * `ucp.status: "error"`. https://ucp.dev/2026-08-25/schemas/common/types/error_response.json
 */
export function renderErrorResponse(
  messages: Array<{ code: string; content: string; severity?: 'recoverable' | 'unrecoverable'; path?: string }>,
  ctx: UcpContext,
) {
  return {
    ucp: envelope(ctx, 'error'),
    messages: messages.map((message) => ({
      type: 'error' as const,
      code: message.code,
      severity: message.severity ?? 'unrecoverable',
      content_type: 'plain' as const,
      content: message.content,
      ...(message.path ? { path: message.path } : {}),
    })),
    continue_url: safeUrl(ctx.business.website, ctx.publicUrl),
  };
}
