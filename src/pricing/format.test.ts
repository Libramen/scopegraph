import { describe, expect, it } from 'vitest';
import { formatMoney, choicePriceHint } from './format.js';
import type { Adjustment, Option } from '../graph/types.js';

const option = (adjustments: Adjustment[]): Option => ({
  id: 'extras.champagne',
  key: 'champagne',
  groupKey: 'extras',
  label: 'Champagne',
  adjustments,
});

const adjustment = (method: Adjustment['method'], kind: Adjustment['kind'] = 'addon'): Adjustment => ({
  id: 'offering.extras.champagne.price',
  label: 'Champagne',
  kind,
  method,
  taxable: true,
  order: 10,
  ownerOfferingId: 'offering',
  ownerOptionId: 'extras.champagne',
});

describe('formatMoney', () => {
  it('formats two-minor-unit currencies', () => {
    expect(formatMoney(20_000, 'USD')).toBe('$200.00');
    expect(formatMoney(2_345, 'USD')).toBe('$23.45');
    expect(formatMoney(5, 'USD')).toBe('$0.05');
    expect(formatMoney(-1_500, 'USD')).toBe('-$15.00');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(123_456_789, 'EUR')).toBe('€1,234,567.89');
  });

  it('formats zero-minor-unit and three-minor-unit currencies correctly', () => {
    expect(formatMoney(1234, 'JPY')).toBe('¥1,234');
    expect(formatMoney(1234, 'KWD')).toBe('KWD\u00A01.234');
    expect(formatMoney(1_234_567, 'KWD')).toBe('KWD\u00A01,234.567');
  });

  it('refuses non-integer minor units', () => {
    expect(() => formatMoney(1.5, 'USD')).toThrow(RangeError);
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(RangeError);
  });
});

describe('choicePriceHint', () => {
  it('hints fixed add-ons and discounts with a sign', () => {
    expect(choicePriceHint(option([adjustment({ type: 'fixed', amountCents: 2_000 })]), 'USD')).toBe('+$20.00');
    expect(choicePriceHint(option([adjustment({ type: 'fixed', amountCents: 2_000 }, 'discount')]), 'USD')).toBe('-$20.00');
  });

  it('hints per-unit amounts with the quantity parameter name', () => {
    expect(choicePriceHint(option([adjustment({ type: 'per_unit', amountCents: 500, per: 'guide_hours' })]), 'USD'))
      .toBe('+$5.00 × guide hours');
  });

  it('hints percentages without trailing zeros', () => {
    expect(choicePriceHint(option([adjustment({ type: 'percent', rateMicros: 150_000, basis: 'running' })]), 'USD')).toBe('+15%');
    expect(choicePriceHint(option([adjustment({ type: 'percent', rateMicros: 85_000, basis: 'running' }, 'discount')]), 'USD'))
      .toBe('-8.5%');
  });

  it('returns undefined for tiered and formula methods', () => {
    expect(choicePriceHint(option([adjustment({ type: 'tiered', per: 'guests', tiers: [{ from: 1, amountCents: 500 }] })]), 'USD'))
      .toBeUndefined();
    expect(choicePriceHint(option([adjustment({ type: 'formula', expression: 'guests * 40', dependencies: ['guests'] })]), 'USD'))
      .toBeUndefined();
  });

  it('skips zero amounts, fees, and keeps scanning after non-hintable methods', () => {
    expect(choicePriceHint(option([adjustment({ type: 'fixed', amountCents: 0 })]), 'USD')).toBeUndefined();
    expect(choicePriceHint(option([adjustment({ type: 'fixed', amountCents: 2_000 }, 'fee')]), 'USD')).toBeUndefined();
    expect(choicePriceHint(option([
      adjustment({ type: 'tiered', per: 'guests', tiers: [{ from: 1, amountCents: 500 }] }),
      adjustment({ type: 'percent', rateMicros: 100_000, basis: 'running' }),
    ]), 'USD')).toBe('+10%');
  });
});
