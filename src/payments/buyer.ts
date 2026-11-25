/**
 * Buyer text hygiene. Buyer fields arrive from anonymous agents (UCP/ACP) or Stripe Checkout
 * and end up in owner terminals (CLI, hook log lines) and owner emails: C0/C1 control
 * characters (ANSI/OSC escapes, NUL, newlines) and the invisible bidi/line-separator
 * characters that reorder or split what the owner reads are removed, and each field is
 * capped. An email must look like `local@domain.tld`.
 */
import type { Buyer } from './types.js';

/**
 * C0/C1 controls, LRM/RLM (U+200E/F), line/paragraph separators (U+2028/9), the bidi
 * embeddings and overrides (U+202A–E) and the bidi isolates (U+2066–9).
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const MAX_BUYER_FIELD = 320;
/** One `@`, no whitespace, at least one dot in the domain and no empty labels. Linear: the parts never overlap. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Removes every C0/C1 control character (incl. ESC, tab, newline) and every bidi/line-separator character. */
export function stripControls(text: string): string {
  return text.replace(UNSAFE_CHARS, '');
}

/** True when `email`, once cleaned, is a plausible address (`local@domain.tld`, at most 320 characters). */
export function isEmailShaped(email: string): boolean {
  const cleaned = stripControls(email).trim();
  return cleaned.length <= MAX_BUYER_FIELD && EMAIL_SHAPE.test(cleaned);
}

/**
 * Control-free, trimmed, ≤ 320 chars per field; empty fields dropped; an email that is not
 * `isEmailShaped` is dropped too (doors refuse one before it gets here); undefined when
 * nothing is left.
 */
export function cleanBuyer(buyer: Buyer | undefined): Buyer | undefined {
  if (!buyer) return undefined;
  const out: Buyer = {};
  for (const key of ['name', 'email', 'phone'] as const) {
    const raw = buyer[key];
    if (raw === undefined || (key === 'email' && !isEmailShaped(raw))) continue;
    const value = stripControls(raw).trim().slice(0, MAX_BUYER_FIELD);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
