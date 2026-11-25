/**
 * Order hooks — THE FILE FORKERS EDIT to hear about payments.
 *
 * Called by the payments module (HTTP server only; payments are never enabled
 * in stdio mode) AFTER the order transition is durably stored, outside any
 * lock. Each hook receives the full `Order`, including the buyer's contact
 * details and answers — keep it out of public channels.
 *
 * Delivery is at-least-once: a hook that throws — or is still running after
 * 10 seconds — is retried by the reconciler (every 60s) up to 5 attempts, then
 * given up with a log line. A timed-out call is not canceled, so it may still
 * finish after its retry starts: make your side idempotent (key on `order.id`
 * + hook name) and give your own network calls a timeout (see the examples).
 *
 * Defaults print ONE clear line to stderr. Replace with email / Slack / CRM
 * (examples below each hook).
 */
import type { Order } from '../payments/types.js';
import type { ApprovalLinks } from '../payments/approval/tokens.js';
import { stripControls } from '../payments/buyer.js';

export type { ApprovalLinks } from '../payments/approval/tokens.js';

function money(order: Order): string {
  const cents = order.quote.totalCents;
  return `${order.quote.currency} ${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * A card is held and the owner must approve or reject by `links.expiresAt`
 * (after that the hold is released automatically). `links.approveUrl` /
 * `links.rejectUrl` are signed, single-use and expire at the deadline — anyone
 * holding one can act on the order, so the default never prints them (stderr
 * often ends up in shared log storage); deliver them privately (examples
 * below). The CLI works too: `npm run sg -- orders approve <id>` / `… reject <id>`.
 */
export async function onApprovalNeeded(order: Order, links: ApprovalLinks): Promise<void> {
  console.error(
    `scopegraph: APPROVAL NEEDED order ${order.id} — ${money(order)}; decide by ${links.expiresAt}:`
      + ` npm run sg -- orders approve ${order.id} (or: npm run sg -- orders reject ${order.id})`,
  );

  // ── EXAMPLE: email the owner (any transactional email API) ────────────────
  // await fetch('https://api.postmarkapp.com/email', {
  //   method: 'POST',
  //   headers: { 'content-type': 'application/json', 'X-Postmark-Server-Token': process.env.POSTMARK_TOKEN ?? '' },
  //   body: JSON.stringify({
  //     From: 'bookings@example.com',
  //     To: 'owner@example.com',
  //     Subject: `Approve ${order.offering} for ${money(order)}?`,
  //     TextBody: `Buyer: ${order.buyer?.name ?? ''} <${order.buyer?.email ?? ''}>\n`
  //       + `Answers: ${JSON.stringify(order.request.answers)}\n\n`
  //       + `Approve: ${links.approveUrl}\nReject: ${links.rejectUrl}\nDecide by ${links.expiresAt}`,
  //   }),
  //   signal: AbortSignal.timeout(5000),
  // });
  //
  // ── EXAMPLE: Slack incoming webhook ───────────────────────────────────────
  // await fetch(process.env.SLACK_WEBHOOK_URL ?? '', {
  //   method: 'POST',
  //   headers: { 'content-type': 'application/json' },
  //   body: JSON.stringify({ text: `New booking needs approval: ${order.offering} ${money(order)} — <${links.approveUrl}|approve> / <${links.rejectUrl}|reject>` }),
  //   signal: AbortSignal.timeout(5000),
  // });
}

/** Money was captured. Confirm the booking with the buyer / your calendar. */
export async function onPaid(order: Order): Promise<void> {
  console.error(
    `scopegraph: PAID order ${order.id} — ${order.offering} ${money(order)}`
      + ` (buyer ${stripControls(order.buyer?.email ?? order.buyer?.name ?? 'unknown')})`
      + (order.statusReason !== undefined ? ` [${order.statusReason}]` : ''),
  );

  // ── EXAMPLE: create the CRM deal / booking ─────────────────────────────────
  // await fetch('https://hooks.example.com/crm/deals', {
  //   method: 'POST',
  //   headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CRM_TOKEN ?? ''}` },
  //   body: JSON.stringify({ id: order.id, offering: order.offering, total_cents: order.quote.totalCents,
  //     currency: order.quote.currency, buyer: order.buyer, answers: order.request.answers, date: order.request.date }),
  //   signal: AbortSignal.timeout(5000),
  // });
}

/**
 * The order ended without (or after reversing) payment: rejected, expired,
 * canceled, payment_failed or refunded. `order.statusReason` says why.
 */
export async function onClosed(order: Order): Promise<void> {
  console.error(
    `scopegraph: CLOSED order ${order.id} — ${order.status}`
      + (order.statusReason !== undefined ? ` (${order.statusReason})` : '')
      + ` ${order.offering} ${money(order)}`,
  );

  // ── EXAMPLE: tell the buyer by email ───────────────────────────────────────
  // if (order.buyer?.email) {
  //   await sendEmail(order.buyer.email, 'Your booking request', `Status: ${order.status}. No charge was made.`);
  // }
}
