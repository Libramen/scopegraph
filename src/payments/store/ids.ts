/**
 * Opaque payment ids: `<prefix>_` + 24 chars of RFC 4648 base32 (lowercase)
 * over 15 random bytes — 120 bits, unguessable, no oracle by enumeration.
 */
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'qt' | 'ord' | 'chk';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function newId(prefix: IdPrefix): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of randomBytes(15)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return `${prefix}_${out}`;
}

const PATTERNS: Record<IdPrefix, RegExp> = {
  qt: /^qt_[a-z2-7]{24}$/,
  ord: /^ord_[a-z2-7]{24}$/,
  chk: /^chk_[a-z2-7]{24}$/,
};

/** Shape check only — lets routes answer 404 without touching the store. */
export function isId(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === 'string' && PATTERNS[prefix].test(value);
}
