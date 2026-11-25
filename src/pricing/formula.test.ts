import { describe, expect, it } from 'vitest';
import { FormulaError, evaluateFormula, parseFormula } from './formula.js';
import { parseDecimal } from './fraction.js';

describe('parseFormula', () => {
  it('returns snake_case parameter dependencies, sorted and unique', () => {
    expect(parseFormula('nights * 40 + guests * 5')).toEqual({
      ok: true,
      dependencies: ['guests', 'nights'],
    });
    expect(parseFormula('hours * hours')).toEqual({ ok: true, dependencies: ['hours'] });
    expect(parseFormula('100 + 2.5')).toEqual({ ok: true, dependencies: [] });
    expect(parseFormula('(adults - kids_under_2) * tour_price')).toEqual({
      ok: true,
      dependencies: ['adults', 'kids_under_2', 'tour_price'],
    });
  });

  it.each([
    ['', 'Formula is empty or longer than 2048 characters.'],
    ['nights % 40', 'Formula: "%" is not allowed'],
    ['nights & 40', 'Formula: "&" is not allowed'],
    ['Nights * 40', 'Formula: "N" is not allowed'],
    ['night$ * 40', 'Formula: "$" is not allowed'],
    ['nights *', 'Formula is incomplete.'],
    ['* 40', 'Formula has a misplaced operator or value.'],
    ['(nights * 40', 'Formula has an unclosed "(".'],
    ['nights * 40)', 'Formula has extra input after the expression.'],
    ['nights ** 40', 'Formula has a misplaced operator or value.'],
  ])('rejects %p with a readable message', (expression, fragment) => {
    const result = parseFormula(expression);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(fragment);
  });

  it('supports unary minus and honors operator precedence', () => {
    expect(parseFormula('-nights * 40 + -(guests + 1)')).toEqual({
      ok: true,
      dependencies: ['guests', 'nights'],
    });
    expect(evaluateFormula('2 + 3 * 4', {})).toEqual(parseDecimal(14));
    expect(evaluateFormula('(2 + 3) * 4', {})).toEqual(parseDecimal(20));
  });
});

describe('evaluateFormula', () => {
  it('evaluates over parameter values exactly (no float drift)', () => {
    expect(evaluateFormula('nights * 40 + guests * 5', { nights: 2, guests: 8 })).toEqual(
      parseDecimal(120),
    );
    // 0.1 + 0.2 is exactly 0.3 in exact fraction arithmetic.
    expect(evaluateFormula('nights + 0.2', { nights: 0.1 })).toEqual(parseDecimal('0.3'));
    expect(evaluateFormula('hours * 2.675', { hours: 1 })).toEqual(parseDecimal('2.675'));
    expect(evaluateFormula('total / guests', { total: 100, guests: 4 })).toEqual(
      parseDecimal(25),
    );
  });

  it('accepts decimal strings for dependencies', () => {
    expect(evaluateFormula('hours * 3', { hours: '1.5' })).toEqual(parseDecimal('4.5'));
  });

  it('fails closed when a dependency is missing or non-numeric', () => {
    expect(() => evaluateFormula('nights * 40', {})).toThrow(FormulaError);
    expect(() => evaluateFormula('nights * 40', { nights: undefined })).toThrow(
      /needs a value for nights/,
    );
    expect(() => evaluateFormula('nights * 40', { nights: null })).toThrow(FormulaError);
    expect(() => evaluateFormula('nights * 40', { nights: true })).toThrow(
      /value for nights is not a number/,
    );
    expect(() => evaluateFormula('nights * 40', { nights: '1e3' })).toThrow(FormulaError);
    expect(() => evaluateFormula('nights * 40', { nights: 1e-7 })).toThrow(FormulaError);
  });

  it('rejects negative dependency values (fail closed)', () => {
    expect(() => evaluateFormula('hours * 50 + guests * 5', { hours: 1, guests: -9 })).toThrow(
      /value for guests is negative/,
    );
    expect(() => evaluateFormula('hours * 2', { hours: '-3' })).toThrow(
      /value for hours is negative/,
    );
  });
  it('rejects division by zero deterministically', () => {
    expect(() => evaluateFormula('nights / hours', { nights: 1, hours: 0 })).toThrow(
      /Division by zero/,
    );
  });

  it('rejects expressions that exceed the resource ceilings', () => {
    expect(parseFormula('9'.repeat(2_049)).ok).toBe(false);
    expect(parseFormula(`${'nights + '.repeat(130)}1`).ok).toBe(false);
    expect(parseFormula('('.repeat(33) + '1' + ')'.repeat(33)).ok).toBe(false);
    const manyDeps = Array.from({ length: 65 }, (_, i) => `dep_${i}`).join(' + ');
    expect(parseFormula(manyDeps).ok).toBe(false);
  });

  it('parseFormula and evaluateFormula agree on dependencies', () => {
    const expression = 'nights * 40 + guests * 5';
    const parsed = parseFormula(expression);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const values = Object.fromEntries(parsed.dependencies.map((name) => [name, 1]));
      expect(evaluateFormula(expression, values)).toEqual(parseDecimal(45));
    }
  });
});
