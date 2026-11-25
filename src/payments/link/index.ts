/**
 * Payment link door (docs/payments.md § The four doors).
 *
 * The only door where a human pays unattended: `startLinkOrder` creates (or
 * idempotently reuses) an `awaiting_payment` order with a manual-capture Stripe
 * Checkout Session, and this module hands out that session url three ways:
 *
 *   - MCP tool `create_payment_link {quote}` (agents serving a human buyer)
 *   - POST /api/quotes/:id/payment-link (JSON; same funnel)
 *   - GET/POST /quotes/:id/pay — the UCP `continue_url`: a prefetch-safe page
 *     (GET never creates an order; link unfurlers must not lock the quote to
 *     door=link) whose only control POSTs and 303-redirects to Stripe.
 *
 * Refusals (quote expired / in use by another door) render as pages, never as
 * a redirect to Stripe.
 */
import { Router } from 'express';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { DoorDeps, DoorModule, PaymentMcpTool, PublicOrder, ServiceError } from '../types.js';
import { STRIPE_CHECKOUT_ORIGIN, escapeHtml, formatMoney, sendHtml } from '../approval/html.js';

/** Everything every caller of this door wants from one started link order. */
interface LinkOrderStart {
  order: PublicOrder;
  url: string;
  /** Checkout Session expiry (falls back to the quote expiry while durable state catches up). */
  expiresAt: string;
}

/** Create/reuse the link order, enriched with the session url and expiry. */
async function startLinkOrder(deps: DoorDeps, quoteId: string): Promise<
  { ok: true; value: LinkOrderStart } | { ok: false; error: ServiceError; message: string }
> {
  const result = await deps.service.startLinkOrder(quoteId);
  if (!result.ok) return result;
  const { order, url } = result.value;
  const [full, quote] = await Promise.all([deps.service.getOrder(order.id), deps.service.getQuote(quoteId)]);
  const expiresAt = full?.stripe.checkoutSessionExpiresAt ?? quote?.expiresAt ?? order.approvalDeadline ?? '';
  return { ok: true, value: { order, url, expiresAt } };
}

// ─── MCP tool ────────────────────────────────────────────────────────────────

function createPaymentLinkToolDefinition(confirmation: DoorDeps['config']['confirmation']): Tool {
  return {
    name: 'create_payment_link',
    title: 'Create payment link',
    description:
      'Create a hosted Stripe payment page for one quote, to hand to a HUMAN or a browser-using agent. ' +
      'Use it when the buyer will pay by card themselves (chat, email, sms); use create_checkout (UCP) instead when YOU hold a Stripe shared payment token. ' +
      'The link expires with the Checkout Session. ' +
      (confirmation === 'owner_approves'
        ? 'Owner approval semantics: the card is authorized on the Stripe page, but money is only captured once the business approves (before the stated deadline); otherwise the hold is released. '
        : 'The card is charged when the buyer completes payment on the Stripe page. ') +
      'Returns { order, url, expiresAt }. Idempotent while the order is awaiting payment: the same url comes back.',
    inputSchema: {
      type: 'object',
      properties: {
        quote: {
          type: 'string',
          description: 'Quote id from scope_offering (`qt_…`). Unexpired and not already locked to another payment method.',
        },
      },
      required: ['quote'],
    },
  };
}

/** Same result shape as the scoping tools in `src/server/mcp.ts`. */
function toolResult(payload: unknown): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function toolError(payload: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

function createPaymentLinkTool(deps: DoorDeps): PaymentMcpTool {
  return {
    tool: createPaymentLinkToolDefinition(deps.config.confirmation),
    async call(args: Record<string, unknown>): Promise<CallToolResult> {
      const quoteId = args.quote;
      if (typeof quoteId !== 'string' || quoteId === '') {
        return toolError({
          error: 'invalid_arguments',
          message: '`quote` is required (a quote id from scope_offering, `qt_…`).',
        });
      }
      const result = await startLinkOrder(deps, quoteId);
      if (!result.ok) {
        return toolError({ error: result.error, message: result.message });
      }
      const { order, url, expiresAt } = result.value;
      return toolResult({ order, url, expiresAt });
    },
  };
}

// ─── HTML pages ──────────────────────────────────────────────────────────────

/**
 * Trailer for refusal pages whose refusal provably took no payment (no card
 * was ever asked for). NEVER for `invalid_state`/`quote_in_use` — another
 * payment flow for this quote may already have authorized a card — nor for
 * `payment_pending`, where the outcome is unknown.
 */
function refusal(message: string): string {
  return `<p>${message}</p><p>No payment was taken. Contact the business to restart with a fresh quote.</p>`;
}

function orderLink(orderId: string): string {
  const href = escapeHtml(`/orders/${orderId}`);
  return `<a href="${href}">${href}</a>`;
}

// ─── HTTP routes ─────────────────────────────────────────────────────────────

/** Repo-wide API error convention (`src/server/app.ts`): plain JSON `{ error, message }`. */
function apiErrorStatus(error: ServiceError): number {
  switch (error) {
    case 'quote_not_found':
      return 404;
    case 'quote_expired':
    case 'requote_required':
      return 410;
    case 'amount_too_small':
      return 422;
    case 'too_many_attempts':
      return 429;
    case 'payment_pending':
      return 503;
    default:
      return 409;
  }
}

export function createLinkDoor(deps: DoorDeps): DoorModule {
  const router = Router();

  // JSON entry for agents/servers: same funnel as the MCP tool.
  router.post('/api/quotes/:id/payment-link', async (req, res) => {
    const result = await startLinkOrder(deps, req.params.id);
    if (!result.ok) {
      if (result.error === 'payment_pending') {
        // Should never happen (startLinkOrder cannot go pending — service
        // contract), but surface it retryable rather than payable if it does.
        res.status(503).setHeader('Retry-After', '5').json({ error: result.error, message: result.message });
        return;
      }
      res.status(apiErrorStatus(result.error)).json({ error: result.error, message: result.message });
      return;
    }
    const { order, url, expiresAt } = result.value;
    res.json({ order, url, expiresAt });
  });

  // Prefetch-safe quote summary (the UCP `continue_url`). GET never creates an
  // order — link unfurlers must not lock the quote to door=link.
  router.get('/quotes/:id/pay', async (req, res) => {
    const quoteId = req.params.id;
    const quote = await deps.service.getQuote(quoteId);
    if (!quote) {
      sendHtml(res, 404, 'Quote not found', refusal('This payment page is not valid.'));
      return;
    }
    if (Date.parse(quote.expiresAt) <= deps.now().getTime()) {
      sendHtml(res, 410, 'Quote expired', refusal('This quote has expired and can no longer be paid.'));
      return;
    }
    const live = await deps.service.getLiveOrderForQuote(quoteId);
    if (live && live.door !== 'link') {
      // Another payment flow for this quote may be mid-flight: no "no payment" claim.
      sendHtml(res, 403, 'Quote in use', '<p>This quote is already being paid through another payment method.</p>');
      return;
    }
    if (live && live.status === 'paid') {
      sendHtml(res, 200, 'Already paid', `<p>This order has already been paid.</p><p>Order status: ${orderLink(live.id)}</p>`);
      return;
    }
    if (live && live.status !== 'awaiting_payment') {
      // Link order past checkout (awaiting_approval/capturing/…) — nothing to continue.
      sendHtml(
        res,
        200,
        'Payment in progress',
        `<p>Payment for this quote is already in progress (status: ${escapeHtml(live.status)}).</p>` +
          `<p>Order status: ${orderLink(live.id)}</p>`,
      );
      return;
    }
    const { business } = deps.getGraph();
    const { currency, lines, totalCents } = quote.quote;
    const rows = lines
      .map((line) => {
        const label = escapeHtml(line.label);
        const amount = escapeHtml(formatMoney(line.amountCents, currency));
        const cls = line.amountCents < 0 ? ' class="discount"' : '';
        return `<tr${cls}><td>${label}</td><td>${amount}</td></tr>`;
      })
      .join('\n');
    sendHtml(
      res,
      200,
      'Review your quote',
      `<p class="business">${escapeHtml(business.name)}</p>` +
        `<p>Quote <code>${escapeHtml(quoteId)}</code> for <code>${escapeHtml(quote.offering)}</code> — valid until ${escapeHtml(quote.expiresAt)}.</p>` +
        '<table><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>\n' +
        rows +
        `\n<tr class="total"><td>Total</td><td>${escapeHtml(formatMoney(totalCents, currency))}</td></tr>` +
        '</tbody></table>' +
        (deps.config.confirmation === 'owner_approves'
          ? '<p>You will pay securely on Stripe. Your card is only captured once the business confirms the booking.</p>'
          : '<p>You will pay securely on Stripe. Your card is charged when you complete payment on Stripe.</p>') +
        '<form method="post" action=""><button type="submit">Continue to secure payment</button></form>',
      // The POST answers with a 303 to Stripe Checkout; form-action covers that redirect.
      STRIPE_CHECKOUT_ORIGIN,
    );
  });

  // The Continue button: create/reuse the link order, then hand off to Stripe.
  router.post('/quotes/:id/pay', async (req, res) => {
    const result = await startLinkOrder(deps, req.params.id);
    if (result.ok) {
      res.redirect(303, result.value.url);
      return;
    }
    if (result.error === 'payment_pending') {
      // Should never happen (startLinkOrder cannot go pending — service
      // contract), but surface it retryable rather than payable if it does.
      sendHtml(
        res,
        503,
        'Payment confirmation pending',
        '<p>The outcome of this payment is not confirmed yet. Try again in a few seconds; do not start a new payment for this quote.</p>',
      );
      return;
    }
    if (result.error === 'quote_not_found') {
      sendHtml(res, 404, 'Quote not found', refusal('This payment page is not valid.'));
      return;
    }
    if (result.error === 'quote_expired' || result.error === 'requote_required') {
      sendHtml(res, 410, 'Quote expired', refusal('This quote has expired and can no longer be paid.'));
      return;
    }
    if (result.error === 'invalid_state' || result.error === 'quote_in_use') {
      // Another payment flow for this quote may already have authorized a
      // card: never claim "no payment was taken" here.
      sendHtml(res, 403, 'Cannot pay this quote', `<p>${escapeHtml(result.message)}</p>`);
      return;
    }
    sendHtml(res, 403, 'Cannot pay this quote', refusal(escapeHtml(result.message)));
  });

  return { router, mcpTools: [createPaymentLinkTool(deps)] };
}
