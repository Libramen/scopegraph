/**
 * Qualified hook — THE FILE FORKERS EDIT to hand a qualified request off to
 * whatever takes bookings (booking page, CRM, webhook, Slack, …).
 *
 * Called exactly when a scope request reaches `status: 'qualified'` with a
 * priced quote. Whatever you return is surfaced to the buyer agent as
 * `next` — it should be the ONE action the buyer takes now (a booking URL
 * pre-filled with the scoping result, and/or a short message).
 *
 * The default implementation templates `business.handoff.url` from
 * `catalog/business.yaml`:
 *
 *   handoff:
 *     url: https://book.example.com/{offering}?total={total_cents}&{params}
 *     message: "We're holding this quote for 24 hours."
 *
 * Placeholders:
 *   {offering}    offering id, URL-encoded (`surf-lesson`)
 *   {total}       total in major units with 2 decimals (`146.00`)
 *   {total_cents} total in integer minor units (`14600`) — money is minor units
 *   {currency}    ISO currency code (`USD`)
 *   {params}      URL-encoded query string of the qualifying request:
 *                 every answer, every selection (comma-joined per group),
 *                 then `date` when present — minus any name the template's
 *                 own query already sets (e.g. `total=`), so a buyer answer
 *                 can never repeat (and override) a templated value
 *   {business}    business name, URL-encoded (`Harbor%20Kayak%20Co`)
 *
 * The compiler requires the template to be an absolute http(s) URL.
 */
import type { Business } from '../graph/types.js';
import type { Qualified, ScopeRequest } from '../engine/types.js';

/** What to show the buyer agent after a qualified quote. */
export interface Handoff {
  /** Absolute URL the buyer should be sent to (booking form, checkout, …). */
  url?: string;
  /** One-line instruction to present alongside the quote. */
  message?: string;
}

/** Context for the qualified hook. */
export interface OnQualifiedContext {
  business: Business;
  /** The scope request that qualified (offering + accumulated answers/selections/date). */
  request: ScopeRequest;
}

/** Replace `{placeholder}` tokens in a handoff URL template. */
export function fillHandoffUrl(
  template: string,
  result: Qualified,
  ctx: OnQualifiedContext,
): string {
  // Query names the template sets itself (`?offering={offering}&total={total}&{params}`).
  const queryStart = template.indexOf('?');
  const query = queryStart < 0 ? '' : (template.slice(queryStart + 1).split('#')[0] ?? '');
  const taken = new Set(
    query
      .split('&')
      .filter((pair) => !pair.includes('{params}'))
      .map((pair) => pair.split('=')[0]),
  );
  const params = new URLSearchParams();
  const add = (key: string, value: string): void => {
    if (!taken.has(key)) params.set(key, value);
  };
  for (const [key, value] of Object.entries(result.summary.answers)) {
    add(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  for (const [group, keys] of Object.entries(result.summary.selections)) {
    add(group, keys.join(','));
  }
  if (result.summary.date !== undefined) {
    add('date', result.summary.date);
  }
  const currency = result.quote.currency;
  return template
    .replaceAll('{offering}', encodeURIComponent(result.offering))
    .replaceAll('{total_cents}', String(result.quote.totalCents))
    .replaceAll('{total}', (result.quote.totalCents / 100).toFixed(2))
    .replaceAll('{currency}', currency)
    .replaceAll('{params}', params.toString())
    .replaceAll('{business}', encodeURIComponent(ctx.business.name));
}

/**
 * Default handoff: template `business.handoff.url` (when configured) and
 * pass through `business.handoff.message`.
 */
export async function onQualified(
  result: Qualified,
  ctx: OnQualifiedContext,
): Promise<Handoff | undefined> {
  const { handoff } = ctx.business;
  if (!handoff) return undefined;

  // ── EXAMPLE ────────────────────────────────────────────────────────────────
  // Push the qualified lead into a CRM / webhook instead of (or alongside) the
  // URL handoff (delete the default block above):
  //
  // await fetch('https://hooks.example.com/crm/leads', {
  //   method: 'POST',
  //   headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CRM_TOKEN}` },
  //   body: JSON.stringify({
  //     offering: result.offering,
  //     total_cents: result.quote.totalCents,
  //     currency: result.quote.currency,
  //     lines: result.quote.lines.map((l) => ({ label: l.label, amount_cents: l.amountCents })),
  //     answers: result.summary.answers,
  //     selections: result.summary.selections,
  //     date: result.summary.date ?? null,
  //   }),
  //   signal: AbortSignal.timeout(3000),
  // });
  // return {
  //   message: "You're booked pending confirmation — we'll email within the hour.",
  // };
  // ────────────────────────────────────────────────────────────────────────────

  const handoffResult: Handoff = {};
  if (handoff.url) handoffResult.url = fillHandoffUrl(handoff.url, result, ctx);
  if (handoff.message) handoffResult.message = handoff.message;
  return handoffResult.url !== undefined || handoffResult.message !== undefined
    ? handoffResult
    : undefined;
}
