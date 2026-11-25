import { describe, expect, it } from 'vitest';
import { priceOffering } from './priceOffering.js';
import type {
  Adjustment,
  AdjustmentMethod,
  BaseLine,
  Business,
  Condition,
  Graph,
  Offering,
  Option,
  OptionGroup,
  Parameter,
  Value,
} from '../graph/types.js';
import type { PricingInput } from '../engine/types.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const parameter = (name: string, label = name): Parameter => ({
  name,
  label,
  type: 'number',
  required: true,
  internal: false,
  ownerOfferingId: 'offering',
});

const baseLine = (overrides: Partial<BaseLine> = {}): BaseLine => ({
  offeringId: 'offering',
  label: 'Base price',
  amountCents: 10_000,
  quantity: 1,
  taxable: true,
  ...overrides,
});

const adjustment = (
  id: string,
  kind: Adjustment['kind'],
  method: AdjustmentMethod,
  overrides: Partial<Adjustment> = {},
): Adjustment => ({
  id,
  label: id,
  kind,
  method,
  taxable: true,
  order: 100,
  ownerOfferingId: 'offering',
  ...overrides,
});

const optionGroup = (key: string, options: Option[]): OptionGroup => ({
  key,
  label: key,
  mode: 'multi',
  required: false,
  minSelections: 0,
  options,
});

const option = (key: string, groupKey: string, adjustments: Adjustment[] = []): Option => ({
  id: `${groupKey}.${key}`,
  key,
  groupKey,
  label: key,
  adjustments,
});

const offering = (id: string, overrides: Partial<Offering> = {}): Offering => ({
  id,
  kind: 'product',
  name: id,
  keywords: [],
  status: 'active',
  bookable: true,
  contains: [],
  date: 'none' as const,
  scope: {
    parameters: [],
    optionGroups: [],
    rules: [],
    adjustments: [],
    baseLines: [baseLine()],
    inactiveContents: [],
  },
  ...overrides,
});

const graph = (offerings: Offering[], business: Partial<Business> = {}): Graph => ({
  business: {
    name: 'Test business',
    currency: 'USD',
    timezone: 'UTC',
    facts: {},
    seasons: [],
    disclosure: 'progressive',
    payments: { confirmation: 'owner_approves', approvalWindowHours: 24, quoteTtlMinutes: 30 },
    ...business,
  },
  offerings: Object.fromEntries(offerings.map((item) => [item.id, item])),
});

const input = (
  values: Record<string, Value | undefined> = {},
  chosenOptions: string[] = [],
): PricingInput => {
  const selectedByGroup = new Map<string, ReadonlySet<string>>();
  for (const id of chosenOptions) {
    const groupKey = id.split('.')[0]!;
    const existing = selectedByGroup.get(groupKey) ?? new Set<string>();
    selectedByGroup.set(groupKey, new Set([...existing, id]));
  }
  return {
    context: {
      values,
      chosenOptions: new Set(chosenOptions),
      selectedByGroup,
    },
  };
};

const whenParameterGte = (name: string, value: number): Condition => ({
  ref: 'parameter',
  name,
  op: 'gte',
  value,
});

// ─── base lines ──────────────────────────────────────────────────────────────

describe('priceOffering: exact bases and quantities', () => {
  it('a flat base price ignores unrelated numeric answers', () => {
    const result = priceOffering(
      graph([offering('hall', { scope: { ...offering('hall').scope, baseLines: [baseLine({ offeringId: 'hall', amountCents: 75_000 })] } })]),
      'hall',
      input({ guests: 60 }),
    );
    expect(result).toMatchObject({
      ok: true,
      quote: {
        subtotalCents: 75_000,
        taxCents: 0,
        totalCents: 75_000,
        lines: [{
          id: 'base:hall',
          kind: 'base',
          amountCents: 75_000,
          quantity: 1,
          unitAmountCents: 75_000,
          taxable: true,
          source: { offering: 'hall' },
        }],
      },
    });
  });

  it('a per-unit add-on is its unit amount × its parameter', () => {
    const perGuest = adjustment('dinner.per_guest', 'addon', { type: 'per_unit', amountCents: 2_500, per: 'guests' }, { ownerOfferingId: 'dinner' });
    const result = priceOffering(
      graph([offering('dinner', {
        scope: {
          ...offering('dinner').scope,
          parameters: [parameter('guests')],
          adjustments: [perGuest],
          baseLines: [baseLine({ amountCents: 50_000 })],
        },
      })]),
      'dinner',
      input({ guests: 100 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.subtotalCents).toBe(300_000);
    expect(result.quote.lines[1]).toMatchObject({
      id: 'dinner.per_guest',
      quantity: 100,
      unitAmountCents: 2_500,
      amountCents: 250_000,
      source: { offering: 'dinner', adjustment: 'dinner.per_guest' },
    });
  });

  it('rounds a decimal quantity once, after exact multiplication', () => {
    const hourly = adjustment('metered.hourly', 'addon', { type: 'per_unit', amountCents: 100, per: 'hours' }, { taxable: false });
    const result = priceOffering(
      graph([offering('metered', {
        scope: {
          ...offering('metered').scope,
          adjustments: [hourly],
          baseLines: [baseLine({ amountCents: 0, taxable: false })],
        },
      })]),
      'metered',
      input({ hours: 2.005 }),
    );
    // 2.005 × 100 = 200.5 exactly → 201 (a float product would give 200.49999…).
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 201, totalCents: 201 } });
  });

  it('multiplies a base line by its per-bound parameter and quantity', () => {
    const result = priceOffering(
      graph([offering('tour', {
        scope: {
          ...offering('tour').scope,
          parameters: [parameter('participants', 'Participants')],
          baseLines: [baseLine({ offeringId: 'tour', amountCents: 7_300, per: 'participants', quantity: 2 })],
        },
      })]),
      'tour',
      input({ participants: 4 }),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 58_400 } });
    expect(result.ok && result.quote.lines[0]).toMatchObject({ id: 'base:tour', amountCents: 58_400, unitAmountCents: 7_300 });
  });

  it.each([
    ['a quantity in exponent notation', { hours: 1e-7 }],
    ['a missing quantity', {}],
    ['a negative quantity', { hours: -2 }],
    ['a boolean quantity', { hours: true }],
  ])('fails closed (PRICING_ERROR) for %p', (_name, values) => {
    const hourly = adjustment('metered.hourly', 'addon', { type: 'per_unit', amountCents: 100, per: 'hours' });
    const result = priceOffering(
      graph([offering('metered', { scope: { ...offering('metered').scope, adjustments: [hourly] } })]),
      'metered',
      input(values),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PRICING_ERROR');
      expect(result.message).toContain('metered.hourly');
    }
  });

  it('prices a zero quantity as $0 (zero is exact, not unknown)', () => {
    const hourly = adjustment('metered.hourly', 'addon', { type: 'per_unit', amountCents: 100, per: 'hours' });
    const result = priceOffering(
      graph([offering('metered', { scope: { ...offering('metered').scope, adjustments: [hourly], baseLines: [baseLine({ amountCents: 0 })] } })]),
      'metered',
      input({ hours: 0 }),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 0 } });
  });
});

// ─── formulas ────────────────────────────────────────────────────────────────

describe('priceOffering: formula adjustments', () => {
  const formulaOffering = (expression: string, dependencies: string[]) =>
    offering('cabin', {
      scope: {
        ...offering('cabin').scope,
        parameters: [parameter('nights'), parameter('guests')],
        baseLines: [baseLine({ amountCents: 0 })],
        adjustments: [adjustment('cabin.formula', 'addon', { type: 'formula', expression, dependencies }, { taxable: false })],
      },
    });

  it('evaluates snake_case formulas over parameter values in major units', () => {
    const result = priceOffering(
      graph([formulaOffering('nights * 40 + guests * 5', ['nights', 'guests'])]),
      'cabin',
      input({ nights: 2, guests: 8 }),
    );
    // (2*40 + 8*5) = 120 major = 12_000 cents.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 12_000 } });
  });

  it('a formula with a missing input is a pricing error', () => {
    const result = priceOffering(
      graph([formulaOffering('nights * 40 + guests * 5', ['nights', 'guests'])]),
      'cabin',
      input({ nights: 2 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('cabin.formula');
  });

  it('an expression outside the formula grammar is a pricing error', () => {
    const result = priceOffering(
      graph([formulaOffering('nights % 40', ['nights'])]),
      'cabin',
      input({ nights: 2 }),
    );
    expect(result.ok).toBe(false);
  });

  it('a formula result too large for cents is a pricing error', () => {
    const result = priceOffering(
      graph([formulaOffering('units * 9007199254740991', ['units'])]),
      'cabin',
      input({ units: 2 }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a negative formula result (never under-charge)', () => {
    const result = priceOffering(
      graph([formulaOffering('guests - nights', ['nights', 'guests'])]),
      'cabin',
      input({ nights: 5, guests: 1 }),
    );
    expect(result.ok).toBe(false);
  });
});

// ─── tax ─────────────────────────────────────────────────────────────────────

describe('priceOffering: tax', () => {
  it('derives tax from the business rate, rounded once (halves away from zero)', () => {
    const result = priceOffering(
      graph([offering('kayak', { scope: { ...offering('kayak').scope, baseLines: [baseLine({ amountCents: 10_010 })] } })], { taxRateMicros: 82_500 }),
      'kayak',
      input(),
    );
    // 10_010 × 8.25% = 825.825 → 826.
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 10_010, taxCents: 826, totalCents: 10_836 },
    });
  });

  it('leaves a non-taxable fee out of the tax base', () => {
    const fee = adjustment('cabin.cleaning', 'fee', { type: 'fixed', amountCents: 2_500 }, { taxable: false, order: 100 });
    const result = priceOffering(
      graph([offering('cabin', { scope: { ...offering('cabin').scope, adjustments: [fee] } })], { taxRateMicros: 82_500 }),
      'cabin',
      input(),
    );
    // Only the 10_000 base is taxed: 825.
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 12_500, taxCents: 825, totalCents: 13_325 },
    });
  });

  it('taxes a taxable percent service charge too', () => {
    const service = adjustment('cabin.service_charge', 'fee', { type: 'percent', rateMicros: 100_000, basis: 'running' }, { order: 300 });
    const result = priceOffering(
      graph([offering('cabin', { scope: { ...offering('cabin').scope, adjustments: [service] } })], { taxRateMicros: 82_500 }),
      'cabin',
      input(),
    );
    // 11_000 taxable × 8.25% = 907.5 → 908.
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 11_000, taxCents: 908, totalCents: 11_908 },
    });
  });

  it('a taxable discount lowers the tax', () => {
    const discount = adjustment('cabin.promo', 'discount', { type: 'percent', rateMicros: 200_000, basis: 'running' }, { order: 200 });
    const result = priceOffering(
      graph([offering('cabin', { scope: { ...offering('cabin').scope, adjustments: [discount] } })], { taxRateMicros: 82_500 }),
      'cabin',
      input(),
    );
    // 8_000 taxable × 8.25% = 660.
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 8_000, taxCents: 660, totalCents: 8_660 },
    });
  });

  it('charges no tax when there is no business rate or nothing taxable', () => {
    const plain = priceOffering(graph([offering('a')]), 'a', input());
    expect(plain).toMatchObject({ ok: true, quote: { taxCents: 0 } });
    const allExempt = priceOffering(
      graph([offering('b', { scope: { ...offering('b').scope, baseLines: [baseLine({ taxable: false })] } })], { taxRateMicros: 82_500 }),
      'b',
      input(),
    );
    expect(allExempt).toMatchObject({ ok: true, quote: { taxCents: 0, totalCents: 10_000 } });
  });
});

// ─── percent basis ───────────────────────────────────────────────────────────

describe('priceOffering: percent basis', () => {
  const addon = adjustment('offering.delivery', 'addon', { type: 'fixed', amountCents: 5_000 }, { order: 100 });

  it('basis: base takes the percent of the base lines only, not of earlier add-ons', () => {
    const percent = adjustment('offering.handling', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 150 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, adjustments: [addon, percent] } })]),
      'a',
      input(),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 16_000 } });
    expect(result.ok && result.quote.lines[2]).toMatchObject({ id: 'offering.handling', amountCents: 1_000 });
  });

  it('two basis: base surcharges are each a percent of the base lines (no compounding)', () => {
    const first = adjustment('offering.first', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 150 });
    const second = adjustment('offering.second', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 160 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, adjustments: [addon, first, second] } })]),
      'a',
      input(),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 17_000 } });
  });

  it('basis: running includes earlier add-ons', () => {
    const percent = adjustment('offering.handling', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'running' }, { order: 150 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, adjustments: [addon, percent] } })]),
      'a',
      input(),
    );
    // 10_000 + 5_000 = 15_000 → +10% = 1_500 → 16_500.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 16_500 } });
  });

  it('base basis ignores the bundle-discount line too', () => {
    const percent = adjustment('pkg.handling', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 150, ownerOfferingId: 'pkg' });
    const result = priceOffering(
      graph([offering('pkg', {
        kind: 'package',
        scope: {
          ...offering('pkg').scope,
          adjustments: [percent],
          baseLines: [
            baseLine({ offeringId: 'product_a', label: 'Product A', amountCents: 40_000 }),
            baseLine({ offeringId: 'product_b', label: 'Product B', amountCents: 60_000 }),
          ],
          bundleDiscount: { type: 'percent', rateMicros: 100_000 },
        },
      })]),
      'pkg',
      input(),
    );
    // Bases 100_000, bundle −10_000 (line id bundle_discount), then +10% of the
    // BASE lines (100_000), not of 90_000: 100_000 − 10_000 + 10_000 = 100_000.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 100_000 } });
    expect(result.ok && result.quote.lines.map((line) => [line.id, line.amountCents])).toEqual([
      ['base:product_a', 40_000],
      ['base:product_b', 60_000],
      ['bundle_discount', -10_000],
      ['pkg.handling', 10_000],
    ]);
  });

  it('an inherited base-basis adjustment takes only its own product\'s base lines; the package\'s own takes all', () => {
    // `lesson.weekend` is inherited from the contained product `lesson`;
    // `pkg.service` is the package's own. Both are 10% of `basis: base`.
    const inherited = adjustment('lesson.weekend', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 300, ownerOfferingId: 'lesson' });
    const own = adjustment('pkg.service', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 300, ownerOfferingId: 'pkg' });
    const result = priceOffering(
      graph([offering('pkg', {
        kind: 'package',
        scope: {
          ...offering('pkg').scope,
          adjustments: [inherited, own],
          baseLines: [
            baseLine({ offeringId: 'lesson', label: 'Lesson', amountCents: 17_000 }),
            baseLine({ offeringId: 'private', label: 'Private', amountCents: 12_000 }),
          ],
        },
      })]),
      'pkg',
      input(),
    );
    expect(result.ok && result.quote.lines.map((line) => [line.id, line.amountCents])).toEqual([
      ['base:lesson', 17_000],
      ['base:private', 12_000],
      ['lesson.weekend', 1_700], // 10% of the lesson only, not of 29_000
      ['pkg.service', 2_900], // 10% of every base line
    ]);
  });

  it('an inherited base-basis adjustment in a fixed-price package uses the package price', () => {
    // Fixed-price package: its only base line is its own price; there are no
    // per-product lines, so the inherited surcharge is never silently dropped.
    const inherited = adjustment('lesson.weekend', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 300, ownerOfferingId: 'lesson' });
    const result = priceOffering(
      graph([offering('pkg', {
        kind: 'package',
        scope: {
          ...offering('pkg').scope,
          adjustments: [inherited],
          baseLines: [baseLine({ offeringId: 'pkg', label: 'Package', amountCents: 25_000 })],
        },
      })]),
      'pkg',
      input(),
    );
    expect(result.ok && result.quote.lines.map((line) => [line.id, line.amountCents])).toEqual([
      ['base:pkg', 25_000],
      ['lesson.weekend', 2_500],
    ]);
  });
});

// ─── calculation order ───────────────────────────────────────────────────────

describe('priceOffering: calculation order', () => {
  it('lower order runs first: an add-on placed before a percent discount is discounted too', () => {
    const addon = adjustment('offering.service', 'addon', { type: 'fixed', amountCents: 5_000 }, { order: 100 });
    const discount = adjustment('offering.vip', 'discount', { type: 'percent', rateMicros: 200_000, basis: 'running' }, { order: 200 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, adjustments: [addon, discount] } })]),
      'a',
      input(),
    );
    // 15_000 − 20% (3_000) = 12_000 (discount-before-addon would give 13_000).
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 12_000 } });
  });

  it('adjustments with the same order keep declaration order', () => {
    const addon = adjustment('offering.service', 'addon', { type: 'fixed', amountCents: 1_000 }, { order: 100 });
    const percent = adjustment('offering.handling', 'surcharge', { type: 'percent', rateMicros: 100_000, basis: 'running' }, { order: 100 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, baseLines: [baseLine({ offeringId: 'a' })], adjustments: [addon, percent] } })]),
      'a',
      input(),
    );
    // addon first: 11_000 → +10% = 1_100 → 12_100 (reverse would give 12_000).
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 12_100 } });
    expect(result.ok && result.quote.lines.map((line) => line.id)).toEqual([
      'base:a',
      'offering.service',
      'offering.handling',
    ]);
  });
});

// ─── bundle discounts ────────────────────────────────────────────────────────

describe('priceOffering: bundle discount', () => {
  const packageScope = (bundle: NonNullable<Offering['scope']['bundleDiscount']>) => ({
    parameters: [] as Parameter[],
    optionGroups: [] as OptionGroup[],
    rules: [],
    adjustments: [],
    baseLines: [
      baseLine({ offeringId: 'product_a', label: 'Product A', amountCents: 40_000 }),
      baseLine({ offeringId: 'product_b', label: 'Product B', amountCents: 60_000 }),
    ],
    bundleDiscount: bundle,
    inactiveContents: [],
  });

  it('applies a percent bundle discount off the base lines, taxable, with a trace entry', () => {
    const result = priceOffering(
      graph([offering('pkg', { kind: 'package', scope: packageScope({ type: 'percent', rateMicros: 100_000 }) })], { taxRateMicros: 82_500 }),
      'pkg',
      input(),
    );
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 90_000, taxCents: 7_425, totalCents: 97_425 },
    });
    expect(result.ok && result.quote.lines[2]).toMatchObject({
      id: 'bundle_discount',
      kind: 'bundle_discount',
      amountCents: -10_000,
      taxable: true,
      source: { offering: 'pkg' },
    });
    expect(result.ok && result.trace[0]).toMatchObject({ id: 'bundle_discount', applied: true, amountCents: -10_000 });
  });

  it('applies a fixed bundle discount and clamps it at the base subtotal', () => {
    const result = priceOffering(
      graph([offering('pkg', { kind: 'package', scope: packageScope({ type: 'fixed', amountCents: 150_000 }) })]),
      'pkg',
      input(),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 0 } });
    expect(result.ok && result.quote.lines[2]).toMatchObject({ amountCents: -100_000 });
    expect(result.ok && result.trace[0]?.note).toMatch(/Clamped/);
  });

  it('treats the bundle discount as non-taxable when any base line is non-taxable', () => {
    const mixed = {
      ...packageScope({ type: 'percent', rateMicros: 100_000 }),
      baseLines: [
        baseLine({ offeringId: 'product_a', label: 'Product A', amountCents: 40_000 }),
        baseLine({ offeringId: 'product_b', label: 'Product B', amountCents: 60_000, taxable: false }),
      ],
    };
    const result = priceOffering(
      graph([offering('pkg', { kind: 'package', scope: mixed })], { taxRateMicros: 100_000 }),
      'pkg',
      input(),
    );
    // Taxable: 40_000 (bundle line is non-taxable) → tax 4_000; total 94_000.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 90_000, taxCents: 4_000, totalCents: 94_000 } });
  });
});

// ─── minimum spend ───────────────────────────────────────────────────────────

describe('priceOffering: minimum spend', () => {
  const withMinimum = (amountCents: number, mode: 'decline' | 'top_up', baseAmountCents = 5_000) =>
    offering('boat', {
      minimumSpend: { amountCents, mode },
      scope: { ...offering('boat').scope, baseLines: [baseLine({ amountCents: baseAmountCents })] },
    });

  it('top_up adds a taxable minimum-spend line for the shortfall', () => {
    const result = priceOffering(graph([withMinimum(7_500, 'top_up')]), 'boat', input());
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 7_500, totalCents: 7_500 },
      minimumSpend: { minimumCents: 7_500, shortfallCents: 2_500, mode: 'top_up' },
    });
    expect(result.ok && result.quote.lines[1]).toMatchObject({
      id: 'minimum_spend',
      kind: 'minimum_spend',
      amountCents: 2_500,
      taxable: true,
    });
  });

  it('top_up adds nothing when the subtotal already meets the minimum', () => {
    const result = priceOffering(graph([withMinimum(7_500, 'top_up', 10_000)]), 'boat', input());
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 10_000, totalCents: 10_000 },
      minimumSpend: { minimumCents: 7_500, shortfallCents: 0 },
    });
    expect(result.ok && result.quote.lines.some((line) => line.kind === 'minimum_spend')).toBe(false);
  });

  it('a discount that takes the subtotal under the minimum triggers the top-up', () => {
    const discount = adjustment('boat.promo', 'discount', { type: 'fixed', amountCents: 4_000 }, { order: 200 });
    const product = withMinimum(7_500, 'top_up', 10_000);
    product.scope.adjustments.push(discount);
    const result = priceOffering(graph([product]), 'boat', input());
    // 10_000 − 4_000 = 6_000, topped up by 1_500.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 7_500 } });
    expect(result.ok && result.quote.lines.find((line) => line.kind === 'minimum_spend')).toMatchObject({ amountCents: 1_500 });
  });

  it('the top-up line is taxed like the base', () => {
    const result = priceOffering(graph([withMinimum(7_500, 'top_up')], { taxRateMicros: 100_000 }), 'boat', input());
    // Taxable 5_000 + 2_500 = 7_500 → tax 750; total 8_250.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 7_500, taxCents: 750, totalCents: 8_250 } });
  });

  it('the top-up is measured after a discount is clamped at zero', () => {
    const discount = adjustment('boat.voucher', 'discount', { type: 'fixed', amountCents: 40_000 }, { order: 200 });
    const product = withMinimum(7_500, 'top_up', 10_000);
    product.scope.adjustments.push(discount);
    const result = priceOffering(graph([product]), 'boat', input());
    // Discount clamped to −10_000 (subtotal 0), so the top-up is the full 7_500.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 7_500 } });
    expect(result.ok && result.quote.lines.find((line) => line.id === 'boat.voucher')).toMatchObject({ amountCents: -10_000 });
    expect(result.ok && result.trace.find((entry) => entry.id === 'boat.voucher')?.note).toMatch(/Clamped/);
  });

  it('decline adds no line and reports the shortfall', () => {
    const result = priceOffering(graph([withMinimum(7_500, 'decline')]), 'boat', input());
    expect(result).toMatchObject({
      ok: true,
      quote: { subtotalCents: 5_000, totalCents: 5_000 },
      minimumSpend: { minimumCents: 7_500, shortfallCents: 2_500, mode: 'decline' },
    });
    expect(result.ok && result.quote.lines.some((line) => line.kind === 'minimum_spend')).toBe(false);
  });

  it('top-up is non-taxable when no base line is taxable', () => {
    const exempt = offering('boat', {
      minimumSpend: { amountCents: 7_500, mode: 'top_up' },
      scope: {
        ...offering('boat').scope,
        baseLines: [baseLine({ offeringId: 'boat', amountCents: 5_000, taxable: false })],
      },
    });
    const result = priceOffering(graph([exempt], { taxRateMicros: 100_000 }), 'boat', input());
    // Taxable sum stays 0, so no tax even though the subtotal is 7_500.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 7_500, taxCents: 0, totalCents: 7_500 } });
    expect(result.ok && result.quote.lines[1]).toMatchObject({ kind: 'minimum_spend', taxable: false });
  });

  it('top-up is taxable when at least one base line is taxable (mixed base)', () => {
    const mixed = offering('pkg', {
      minimumSpend: { amountCents: 7_500, mode: 'top_up' },
      scope: {
        ...offering('pkg').scope,
        baseLines: [
          baseLine({ offeringId: 'product_a', label: 'Product A', amountCents: 3_000, taxable: true }),
          baseLine({ offeringId: 'product_b', label: 'Product B', amountCents: 1_000, taxable: false }),
        ],
      },
    });
    const result = priceOffering(graph([mixed], { taxRateMicros: 100_000 }), 'pkg', input());
    // Subtotal 4_000 → top-up 3_500 (taxable): taxable 3_000 + 3_500 = 6_500 → tax 650.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 7_500, taxCents: 650, totalCents: 8_150 } });
    expect(result.ok && result.quote.lines[2]).toMatchObject({ kind: 'minimum_spend', taxable: true, amountCents: 3_500 });
  });
});

// ─── conditions, options, and trace ──────────────────────────────────────────

describe('priceOffering: conditions, options, and trace', () => {
  it('applies adjustments only when their when-condition is TRUE', () => {
    const weekday = adjustment('venue.weekday_rate', 'discount', { type: 'fixed', amountCents: 1_000 }, { when: whenParameterGte('guests', 50) });
    const result = priceOffering(
      graph([offering('venue', { scope: { ...offering('venue').scope, parameters: [parameter('guests')], adjustments: [weekday] } })]),
      'venue',
      input({ guests: 20 }),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 10_000 } });
    expect(result.ok && result.trace[0]).toMatchObject({
      id: 'venue.weekday_rate',
      when: 'FALSE',
      applied: false,
      amountCents: 0,
    });
  });

  it('records UNKNOWN when-conditions without applying (fail closed, trace explains)', () => {
    const weekday = adjustment('venue.weekday_rate', 'discount', { type: 'fixed', amountCents: 1_000 }, { when: whenParameterGte('guests', 50) });
    const result = priceOffering(
      graph([offering('venue', { scope: { ...offering('venue').scope, parameters: [parameter('guests')], adjustments: [weekday] } })]),
      'venue',
      input({}),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 10_000 } });
    expect(result.ok && result.trace[0]).toMatchObject({ when: 'UNKNOWN', applied: false });
  });

  it('applies selected-option adjustments after offering-level ones, with option source', () => {
    const champagne = option('champagne', 'extras', [
      adjustment('venue.extras.champagne.price', 'addon', { type: 'fixed', amountCents: 4_500 }, { order: 100, ownerOfferingId: 'venue', ownerOptionId: 'extras.champagne' }),
    ]);
    const delivery = option('delivery', 'extras', [
      adjustment('venue.extras.delivery.price', 'addon', { type: 'per_unit', amountCents: 300, per: 'miles' }, { order: 100, ownerOfferingId: 'venue', ownerOptionId: 'extras.delivery' }),
    ]);
    const offeringLevel = adjustment('venue.service', 'fee', { type: 'percent', rateMicros: 100_000, basis: 'running' }, { order: 400 });
    const result = priceOffering(
      graph([offering('venue', {
        scope: {
          ...offering('venue').scope,
          parameters: [parameter('miles')],
          optionGroups: [optionGroup('extras', [champagne, delivery])],
          adjustments: [offeringLevel],
        },
      })]),
      'venue',
      input({ miles: 10 }, ['extras.champagne', 'extras.delivery']),
    );
    // 10_000 + 4_500 + 3_000 = 17_500 → 10% service = 1_750 → 19_250.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 19_250 } });
    expect(result.ok && result.quote.lines.find((line) => line.id === 'venue.extras.champagne.price')?.source).toEqual({
      offering: 'venue',
      option: 'extras.champagne',
      adjustment: 'venue.extras.champagne.price',
    });
  });

  it('ignores unselected options', () => {
    const champagne = option('champagne', 'extras', [
      { ...adjustment('venue.extras.champagne.price', 'addon', { type: 'fixed', amountCents: 4_500 }), ownerOptionId: 'extras.champagne' },
    ]);
    const result = priceOffering(
      graph([offering('venue', { scope: { ...offering('venue').scope, optionGroups: [optionGroup('extras', [champagne])] } })]),
      'venue',
      input({}, []),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 10_000 } });
    expect(result.ok && result.trace.length).toBe(0);
  });

  it('emits a trace entry for every adjustment considered, applied or not', () => {
    const applied = adjustment('venue.a', 'addon', { type: 'fixed', amountCents: 1_000 }, { order: 100 });
    const skipped = adjustment('venue.b', 'addon', { type: 'fixed', amountCents: 1_000 }, { order: 110, when: whenParameterGte('guests', 99) });
    const result = priceOffering(
      graph([offering('venue', { scope: { ...offering('venue').scope, adjustments: [applied, skipped] } })], {}),
      'venue',
      input({ guests: 1 }),
    );
    expect(result.ok && result.trace.map((entry) => [entry.id, entry.applied])).toEqual([
      ['venue.a', true],
      ['venue.b', false],
    ]);
  });

  it('keeps the trace collected before a configuration error', () => {
    const good = adjustment('venue.a', 'addon', { type: 'fixed', amountCents: 1_000 }, { order: 100 });
    const broken = adjustment('venue.b', 'addon', { type: 'per_unit', amountCents: 100, per: 'miles' }, { order: 110 });
    const result = priceOffering(
      graph([offering('venue', { scope: { ...offering('venue').scope, adjustments: [good, broken] } })]),
      'venue',
      input({}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('venue.b');
      expect(result.trace.map((entry) => entry.id)).toEqual(['venue.a']);
    }
  });
});

// ─── discount clamping ───────────────────────────────────────────────────────

describe('priceOffering: discount clamping', () => {
  it('clamps discounts at the running subtotal (subtotal never below zero)', () => {
    const discount = adjustment('a.huge', 'discount', { type: 'fixed', amountCents: 25_000 }, { order: 200 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, adjustments: [discount] } })]),
      'a',
      input(),
    );
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 0 } });
    expect(result.ok && result.quote.lines[1]).toMatchObject({ amountCents: -10_000 });
  });

  it('clamps against the running subtotal only — a non-taxable base still gets its discount', () => {
    // Non-taxable base + default-taxable 10% discount.
    const discount = adjustment('a.ten_off', 'discount', { type: 'percent', rateMicros: 100_000, basis: 'running' }, { order: 200 });
    const result = priceOffering(
      graph([offering('a', {
        scope: {
          ...offering('a').scope,
          baseLines: [baseLine({ offeringId: 'a', taxable: false })],
          adjustments: [discount],
        },
      })], { taxRateMicros: 100_000 }),
      'a',
      input(),
    );
    // Subtotal $90 (not $100); taxable sum is −1_000, so the tax base floors
    // at 0 and no tax is charged.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 9_000, taxCents: 0, totalCents: 9_000 } });
    expect(result.ok && result.quote.lines[1]).toMatchObject({ amountCents: -1_000, taxable: true });
  });

  it('a taxable discount may drive the taxable sum negative; tax base floors at zero', () => {
    // Base 10_000 taxable + 2_000 non-taxable addon; 100% taxable discount.
    const addon = adjustment('a.travel', 'addon', { type: 'fixed', amountCents: 2_000 }, { taxable: false, order: 100 });
    const discount = adjustment('a.bundle', 'discount', { type: 'percent', rateMicros: 1_000_000, basis: 'running' }, { order: 200 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, baseLines: [baseLine({ offeringId: 'a' })], adjustments: [addon, discount] } })], { taxRateMicros: 100_000 }),
      'a',
      input(),
    );
    // Clamped at the full 12_000 running subtotal → subtotal 0; taxable sum
    // 10_000 − 12_000 = −2_000 → tax 0.
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 0, taxCents: 0, totalCents: 0 } });
    expect(result.ok && result.quote.lines[2]).toMatchObject({ amountCents: -12_000 });
  });
});

// ─── overflow and fail-closed safety nets ────────────────────────────────────

describe('priceOffering: overflow and negative inputs fail closed', () => {
  it('returns PRICING_ERROR (never throws) when the running subtotal overflows', () => {
    // Each line is a safe integer; their sum is not.
    const big = 5e13;
    const base = baseLine({ offeringId: 'a', amountCents: 100, per: 'guests' });
    const perGuest = adjustment('a.per_guest', 'addon', { type: 'per_unit', amountCents: 100, per: 'guests' });
    const result = priceOffering(
      graph([offering('a', {
        scope: {
          ...offering('a').scope,
          parameters: [parameter('guests')],
          baseLines: [base],
          adjustments: [perGuest],
        },
      })]),
      'a',
      input({ guests: big }),
    );
    expect(result).toMatchObject({ ok: false, code: 'PRICING_ERROR' });
    if (!result.ok) expect(result.message).toMatch(/safe-integer/);
  });

  it('returns PRICING_ERROR when a single line amount itself overflows to an unsafe cent value', () => {
    // The unit amount is safe, but unit × quantity leaves the safe range; the
    // arithmetic error becomes a pricing error, never a throw.
    const result = priceOffering(
      graph([offering('a', {
        scope: {
          ...offering('a').scope,
          parameters: [parameter('guests')],
          baseLines: [baseLine({ offeringId: 'a', amountCents: 100, per: 'guests' })],
        },
      })], { taxRateMicros: 200_000 }),
      'a',
      input({ guests: 5e13 * 10 }),
    );
    expect(result).toMatchObject({ ok: false, code: 'PRICING_ERROR' });
    if (!result.ok) expect(result.message).toMatch(/out of range/);
  });

  it.each([
    ['a negative base-line per quantity', { guests: -2 }, baseLine({ offeringId: 'a', per: 'guests' }), []],
    ['a negative tiered quantity', { miles: -1 }, baseLine({ offeringId: 'a', amountCents: 0 }), [adjustment('a.delivery', 'addon', { type: 'tiered', per: 'miles', tiers: [{ from: 0, amountCents: 500 }] })]],
  ])('rejects %p', (_name, values, base, adjustments) => {
    const result = priceOffering(
      graph([offering('a', {
        scope: {
          ...offering('a').scope,
          parameters: [parameter('guests'), parameter('miles')],
          baseLines: [base],
          adjustments,
        },
      })]),
      'a',
      input(values),
    );
    expect(result).toMatchObject({ ok: false, code: 'PRICING_ERROR' });
  });

  it('rejects negative formula inputs (safety net)', () => {
    const result = priceOffering(
      graph([offering('a', {
        scope: {
          ...offering('a').scope,
          parameters: [parameter('hours'), parameter('guests')],
          baseLines: [baseLine({ offeringId: 'a', amountCents: 0 })],
          adjustments: [adjustment('a.formula', 'addon', { type: 'formula', expression: 'hours * 50 + guests * 5', dependencies: ['hours', 'guests'] })],
        },
      })]),
      'a',
      input({ hours: 1, guests: -9 }),
    );
    expect(result).toMatchObject({ ok: false, code: 'PRICING_ERROR' });
    if (!result.ok) expect(result.message).toContain('guests');
  });
});

// ─── tiered adjustments ──────────────────────────────────────────────────────

describe('priceOffering: tiered adjustments', () => {
  const tiers = [
    { from: 1, to: 5, amountCents: 500 },
    { from: 6, to: 20, amountCents: 400 },
    { from: 21, amountCents: 350 },
  ];
  const delivery = adjustment('a.delivery', 'addon', { type: 'tiered', per: 'miles', tiers });

  const tiered = offering('a', {
    scope: { ...offering('a').scope, parameters: [parameter('miles')], baseLines: [baseLine({ amountCents: 0 })], adjustments: [delivery] },
  });

  it('picks the tier unit amount for the quantity and multiplies exactly', () => {
    const first = priceOffering(graph([tiered]), 'a', input({ miles: 4 }));
    expect(first).toMatchObject({ ok: true, quote: { subtotalCents: 2_000 } });
    expect(first.ok && first.quote.lines[1]).toMatchObject({ quantity: 4, unitAmountCents: 500 });

    const second = priceOffering(graph([tiered]), 'a', input({ miles: 8 }));
    expect(second).toMatchObject({ ok: true, quote: { subtotalCents: 3_200 } });
    expect(second.ok && second.quote.lines[1]).toMatchObject({ unitAmountCents: 400 });

    const open = priceOffering(graph([tiered]), 'a', input({ miles: 30 }));
    expect(open).toMatchObject({ ok: true, quote: { subtotalCents: 10_500 } });
  });

  it('prefers the highest `from` when tiers overlap', () => {
    const overlapping = offering('a', {
      scope: {
        ...offering('a').scope,
        parameters: [parameter('miles')],
        baseLines: [baseLine({ amountCents: 0 })],
        adjustments: [adjustment('a.delivery', 'addon', {
          type: 'tiered',
          per: 'miles',
          tiers: [
            { from: 1, amountCents: 500 },
            { from: 5, amountCents: 300 },
          ],
        })],
      },
    });
    const result = priceOffering(graph([overlapping]), 'a', input({ miles: 7 }));
    expect(result).toMatchObject({ ok: true, quote: { subtotalCents: 2_100 } });
  });

  it('fails closed when no tier covers the quantity', () => {
    const result = priceOffering(graph([tiered]), 'a', input({ miles: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('a.delivery');
  });
});

// ─── errors and invariants ───────────────────────────────────────────────────

describe('priceOffering: errors and invariants', () => {
  it('returns a pricing error for an unknown offering', () => {
    const result = priceOffering(graph([offering('a')]), 'nope', input());
    expect(result).toMatchObject({ ok: false, code: 'PRICING_ERROR' });
  });

  it('fails closed when a base-line per parameter is missing', () => {
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, baseLines: [baseLine({ per: 'guests' })] } })]),
      'a',
      input({}),
    );
    expect(result.ok).toBe(false);
  });

  it('satisfies the quote invariants (Σ lines = subtotal, subtotal + tax = total)', () => {
    const service = adjustment('a.service', 'fee', { type: 'percent', rateMicros: 100_000, basis: 'running' }, { order: 400 });
    const discount = adjustment('a.vip', 'discount', { type: 'percent', rateMicros: 100_000, basis: 'base' }, { order: 200 });
    const result = priceOffering(
      graph([offering('a', { scope: { ...offering('a').scope, adjustments: [discount, service], baseLines: [baseLine({ amountCents: 33_333 })] } })], { taxRateMicros: 82_500 }),
      'a',
      input(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { quote } = result;
    expect(quote.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(quote.subtotalCents);
    expect(quote.subtotalCents + quote.taxCents).toBe(quote.totalCents);
    expect(quote.currency).toBe('USD');
    for (const line of quote.lines) expect(Number.isSafeInteger(line.amountCents)).toBe(true);
  });
});
