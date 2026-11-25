import { describe, expect, it } from 'vitest';
import {
  DECIMAL_LIMITS,
  FORMULA_LIMITS,
  FractionError,
  add,
  compare,
  divide,
  fromInteger,
  multiply,
  negated,
  parseDecimal,
  roundToInteger,
  toCents,
  type Fraction,
} from './fraction.js';

function expectCode(operation: () => unknown, code: FractionError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FractionError);
  expect((thrown as FractionError).code).toBe(code);
}

describe('parseDecimal', () => {
  it('reads decimal text and numbers as reduced fractions', () => {
    expect(parseDecimal('0.3')).toEqual({ numerator: 3n, denominator: 10n });
    expect(parseDecimal(0.3)).toEqual({ numerator: 3n, denominator: 10n });
    expect(parseDecimal('2.675')).toEqual({ numerator: 107n, denominator: 40n });
    expect(parseDecimal('-007.250')).toEqual({ numerator: -29n, denominator: 4n });
    expect(parseDecimal('000')).toEqual({ numerator: 0n, denominator: 1n });
  });

  it.each(['', '\t2', '2.5\n', '2 5', '+2', '.25', '2.', '2.5.0', '-+2', '2e4', '3E1', '-4e-1', '0x10', '1,5'])(
    'rejects %p (digits, optional "-" and point only)',
    (value) => {
      expectCode(() => parseDecimal(value), 'INVALID_DECIMAL');
    },
  );

  it('rejects numbers that only print in exponent form', () => {
    expectCode(() => parseDecimal(4e22), 'INVALID_DECIMAL');
    expectCode(() => parseDecimal(3e-8), 'INVALID_DECIMAL');
  });

  it.each([NaN, Infinity, -Infinity])('rejects %p', (value) => {
    expectCode(() => parseDecimal(value), 'INVALID_DECIMAL');
  });

  it('rejects every spelling of negative zero', () => {
    expectCode(() => parseDecimal(-0), 'NEGATIVE_ZERO');
    expectCode(() => parseDecimal('-00'), 'NEGATIVE_ZERO');
    expectCode(() => parseDecimal('-0.0'), 'NEGATIVE_ZERO');
  });

  it('takes input right at each limit', () => {
    expect(DECIMAL_LIMITS).toEqual({ maxLength: 64, maxDigits: 38, maxScale: 18, maxBits: 256 });
    expect(parseDecimal(`-${'0'.repeat(62)}7`)).toEqual({ numerator: -7n, denominator: 1n });
    expect(parseDecimal('1'.repeat(38))).toEqual({ numerator: BigInt('1'.repeat(38)), denominator: 1n });
    expect(parseDecimal(`0.${'0'.repeat(17)}3`)).toEqual({ numerator: 3n, denominator: 10n ** 18n });
  });

  it('rejects input just over each limit', () => {
    expectCode(() => parseDecimal('1'.padStart(65, '0')), 'DECIMAL_TOO_LONG');
    expectCode(() => parseDecimal('1'.repeat(39)), 'DECIMAL_TOO_LONG');
    expectCode(() => parseDecimal(`0.${'0'.repeat(18)}3`), 'DECIMAL_TOO_LONG');
  });
});

describe('arithmetic', () => {
  it('keeps sums, products, quotients and comparisons exact', () => {
    expect(add(parseDecimal('0.25'), parseDecimal('0.5'))).toEqual({ numerator: 3n, denominator: 4n });
    expect(add(parseDecimal('2.5'), negated(parseDecimal('0.5')))).toEqual({ numerator: 2n, denominator: 1n });
    expect(multiply(parseDecimal('1.5'), parseDecimal('2.4'))).toEqual({ numerator: 18n, denominator: 5n });
    expect(divide(parseDecimal('2.5'), parseDecimal('-0.5'))).toEqual({ numerator: -5n, denominator: 1n });
    expect(fromInteger(4_200)).toEqual({ numerator: 4200n, denominator: 1n });
    expect(compare(parseDecimal('0.75'), add(parseDecimal('0.25'), parseDecimal('0.5')))).toBe(0);
    expect(compare(parseDecimal('3'), parseDecimal('20'))).toBe(-1);
  });

  it('rounds exact halves away from zero on both sides', () => {
    const cases: Array<[Fraction, bigint]> = [
      [{ numerator: 1n, denominator: 2n }, 1n],
      [{ numerator: 5n, denominator: 2n }, 3n],
      [{ numerator: -1n, denominator: 2n }, -1n],
      [{ numerator: -7n, denominator: 2n }, -4n],
      [{ numerator: 249n, denominator: 100n }, 2n],
      [{ numerator: -249n, denominator: 100n }, -2n],
    ];
    for (const [input, expected] of cases) {
      expect(roundToInteger(input)).toBe(expected);
    }
  });

  it('prices 2.675 × 100 at 268 cents, where floats would give 267', () => {
    const cents = multiply(parseDecimal(2.675), fromInteger(100));
    expect(cents).toEqual({ numerator: 535n, denominator: 2n });
    expect(toCents(cents)).toBe(268);
  });

  it('normalises the sign onto the numerator and reduces before the size check', () => {
    expect(roundToInteger({ numerator: 6n, denominator: -4n })).toBe(-2n);
    expect(multiply({ numerator: (1n << 256n) * 3n, denominator: 6n }, { numerator: 1n, denominator: 1n }))
      .toEqual({ numerator: 1n << 255n, denominator: 1n });
  });

  it('rejects division by zero and a zero denominator', () => {
    expectCode(() => divide({ numerator: 3n, denominator: 4n }, { numerator: 0n, denominator: 7n }), 'DIVISION_BY_ZERO');
    expectCode(() => roundToInteger({ numerator: 5n, denominator: 0n }), 'DIVISION_BY_ZERO');
  });

  it('accepts a 256-bit result and rejects anything wider', () => {
    const widest = (1n << 256n) - 1n;
    expect(multiply({ numerator: widest, denominator: 1n }, { numerator: 1n, denominator: 1n }))
      .toEqual({ numerator: widest, denominator: 1n });
    expectCode(() => multiply({ numerator: 1n << 200n, denominator: 1n }, { numerator: 1n << 100n, denominator: 1n }), 'TOO_LARGE');
    expectCode(() => divide({ numerator: 1n, denominator: 1n << 128n }, { numerator: 1n << 200n, denominator: 1n }), 'TOO_LARGE');
  });
});

describe('toCents', () => {
  const integer = (n: bigint): Fraction => ({ numerator: n, denominator: 1n });

  it('returns any cent amount inside the safe-integer range', () => {
    expect(toCents(integer(BigInt(Number.MAX_SAFE_INTEGER)))).toBe(Number.MAX_SAFE_INTEGER);
    expect(toCents(integer(BigInt(Number.MIN_SAFE_INTEGER)))).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('rejects a cent amount just outside the safe-integer range', () => {
    expectCode(() => toCents(integer(BigInt(Number.MAX_SAFE_INTEGER) + 1n)), 'UNSAFE_CENTS');
    expectCode(() => toCents(integer(BigInt(Number.MIN_SAFE_INTEGER) - 1n)), 'UNSAFE_CENTS');
  });
});

describe('FORMULA_LIMITS', () => {
  it('bounds formula length, tokens, depth, variables and steps', () => {
    expect(FORMULA_LIMITS).toEqual({ maxLength: 2_048, maxTokens: 256, maxDepth: 32, maxVariables: 64, maxSteps: 256 });
  });
});
