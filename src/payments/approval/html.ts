/**
 * Minimal server-rendered HTML for payment pages (approval confirmations,
 * order status, the link door's pay page). No scripts, no external assets.
 * Every page carries the same lockdown headers (only the pay page widens
 * `form-action`, to Stripe Checkout); every interpolated value
 * MUST go through `escapeHtml`.
 */
import type { Response } from 'express';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/** The Stripe-hosted Checkout origin: the link door's pay form redirects there. */
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

const STYLE = [
  'body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}',
  'table{border-collapse:collapse;width:100%}td{padding:.25rem .5rem;border-bottom:1px solid #eee}',
  'td.amount{text-align:right;white-space:nowrap}',
  'button{font:inherit;padding:.5rem 1.25rem;margin:.5rem .5rem 0 0;cursor:pointer}',
  'textarea{width:100%;font:inherit}.muted{color:#666}.status{font-weight:600}',
].join('');

/**
 * Send a complete HTML page. `bodyHtml` is inserted verbatim — escape what you interpolate.
 * `formActionSource` widens `form-action` for this page only: browsers apply
 * it to the redirect a form POST answers with, so a form that hands off to
 * another origin needs that origin listed.
 */
export function sendHtml(res: Response, status: number, title: string, bodyHtml: string, formActionSource?: string): void {
  for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) res.setHeader(name, value);
  const formAction = formActionSource === undefined ? "'self'" : `'self' ${formActionSource}`;
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`);
  res
    .status(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<meta name="robots" content="noindex">`
        + `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`
        + `<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`,
    );
}

/** Integer minor units → "USD 146.00" (payments only accept two-decimal currencies). */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${currency.toUpperCase()} ${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}
