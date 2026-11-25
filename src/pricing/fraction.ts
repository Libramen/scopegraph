/**
 * Exact arithmetic for prices: bigint fractions with hard size limits.
 *
 * Every amount stays an exact fraction until the single rounding step to
 * integer cents, so `2.675 × 100` is exactly `267.5` and rounds to `268`,
 * never `267`.
 */

export type Fraction = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

/** Limits on decimal inputs (amounts, quantities) and on any intermediate fraction. */
export const DECIMAL_LIMITS = Object.freeze({
  maxLength: 64,
  maxDigits: 38,
  maxScale: 18,
  maxBits: 256,
} as const);

/** Limits on pricing formulas (see formula.ts). */
export const FORMULA_LIMITS = Object.freeze({
  maxLength: 2_048,
  maxTokens: 256,
  maxDepth: 32,
  maxVariables: 64,
  maxSteps: 256,
} as const);

export type FractionErrorCode =
  | 'INVALID_DECIMAL'
  | 'NEGATIVE_ZERO'
  | 'DECIMAL_TOO_LONG'
  | 'TOO_LARGE'
  | 'DIVISION_BY_ZERO'
  | 'UNSAFE_CENTS';

export class FractionError extends Error {
  readonly code: FractionErrorCode;

  constructor(code: FractionErrorCode, message: string) {
    super(message);
    this.name = 'FractionError';
    this.code = code;
  }
}

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;
const MAX_MAGNITUDE = (1n << BigInt(DECIMAL_LIMITS.maxBits)) - 1n;
const SAFE_LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

const ZERO: Fraction = Object.freeze({ numerator: 0n, denominator: 1n });

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Lowest terms, positive denominator, within MAX_MAGNITUDE. */
function reduced(value: Fraction): Fraction {
  if (value.denominator === 0n) {
    throw new FractionError('DIVISION_BY_ZERO', 'Fraction has a zero denominator.');
  }
  const sign = value.denominator < 0n ? -1n : 1n;
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  if (numerator === 0n) return ZERO;

  const common = gcd(numerator, denominator);
  const result = { numerator: numerator / common, denominator: denominator / common };
  if (abs(result.numerator) > MAX_MAGNITUDE || result.denominator > MAX_MAGNITUDE) {
    throw new FractionError('TOO_LARGE', `Fraction is larger than ${DECIMAL_LIMITS.maxBits} bits.`);
  }
  return result;
}

/**
 * Parse plain base-10 notation (`12`, `-1.5`, `0.005`) into a reduced fraction.
 * Numbers go through their canonical string form, so `0.1` is exactly 1/10.
 * Exponent notation, whitespace, `+`, `.5`, `1.` and negative zero are rejected.
 */
export function parseDecimal(value: string | number): Fraction {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FractionError('INVALID_DECIMAL', 'Number is not finite.');
    if (Object.is(value, -0)) throw new FractionError('NEGATIVE_ZERO', 'Negative zero is not a valid amount.');
    // String() is the shortest round-trip form; exponent forms fail the pattern below.
    text = String(value);
  } else {
    text = value;
  }

  if (text.length > DECIMAL_LIMITS.maxLength) {
    throw new FractionError('DECIMAL_TOO_LONG', `Number has more than ${DECIMAL_LIMITS.maxLength} characters.`);
  }
  if (!PLAIN_DECIMAL.test(text)) {
    throw new FractionError('INVALID_DECIMAL', 'Number must be digits with an optional "-" and decimal point (no spaces, "+" or exponents).');
  }

  const negative = text.startsWith('-');
  const [whole = '', fractionDigits = ''] = (negative ? text.slice(1) : text).split('.');
  const digits = whole + fractionDigits;
  if (negative && /^0+$/.test(digits)) {
    throw new FractionError('NEGATIVE_ZERO', 'Negative zero is not a valid amount.');
  }
  if (fractionDigits.length > DECIMAL_LIMITS.maxScale) {
    throw new FractionError('DECIMAL_TOO_LONG', `Number has more than ${DECIMAL_LIMITS.maxScale} decimal places.`);
  }
  if ((digits.replace(/^0+/, '').length || 1) > DECIMAL_LIMITS.maxDigits) {
    throw new FractionError('DECIMAL_TOO_LONG', `Number is too precise (over ${DECIMAL_LIMITS.maxDigits} digits).`);
  }

  const magnitude = BigInt(digits);
  return reduced({ numerator: negative ? -magnitude : magnitude, denominator: 10n ** BigInt(fractionDigits.length) });
}

/** Exact fraction for an integer (cents, micros, …). */
export function fromInteger(value: number | bigint): Fraction {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new FractionError('INVALID_DECIMAL', 'Integer is outside the safe range.');
  }
  return reduced({ numerator: BigInt(value), denominator: 1n });
}

export function add(a: Fraction, b: Fraction): Fraction {
  const x = reduced(a);
  const y = reduced(b);
  const common = gcd(x.denominator, y.denominator);
  return reduced({
    numerator: x.numerator * (y.denominator / common) + y.numerator * (x.denominator / common),
    denominator: (x.denominator / common) * y.denominator,
  });
}

export function negated(value: Fraction): Fraction {
  return reduced({ numerator: -value.numerator, denominator: value.denominator });
}

export function multiply(a: Fraction, b: Fraction): Fraction {
  const x = reduced(a);
  const y = reduced(b);
  // Cancel across before multiplying to keep intermediates small.
  const g1 = gcd(x.numerator, y.denominator) || 1n;
  const g2 = gcd(y.numerator, x.denominator) || 1n;
  return reduced({
    numerator: (x.numerator / g1) * (y.numerator / g2),
    denominator: (x.denominator / g2) * (y.denominator / g1),
  });
}

export function divide(dividend: Fraction, divisor: Fraction): Fraction {
  const d = reduced(divisor);
  if (d.numerator === 0n) {
    throw new FractionError('DIVISION_BY_ZERO', 'Division by zero.');
  }
  return multiply(dividend, { numerator: d.denominator, denominator: d.numerator });
}

/** Nearest integer; exact halves go away from zero (0.5 → 1, -0.5 → -1). */
export function roundToInteger(value: Fraction): bigint {
  const { numerator, denominator } = reduced(value);
  const quotient = numerator / denominator;
  const remainder = abs(numerator % denominator);
  if (remainder * 2n < denominator) return quotient;
  return quotient + (numerator < 0n ? -1n : 1n);
}

/** Round an exact amount to integer cents (halves away from zero) as a safe JS number. */
export function toCents(value: Fraction): number {
  const cents = roundToInteger(value);
  if (cents < -SAFE_LIMIT || cents > SAFE_LIMIT) {
    throw new FractionError('UNSAFE_CENTS', 'Amount in cents is too large to represent exactly.');
  }
  return Number(cents);
}

export function compare(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const difference = add(a, negated(b)).numerator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** JS number for display and traces only; never feed it back into price arithmetic. */
export function toApproxNumber(value: Fraction): number {
  return Number(value.numerator) / Number(value.denominator);
}
