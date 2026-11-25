/**
 * `priceOffering` — exact quote assembly for one offering against one
 * evaluation context, over the compiled Graph shape:
 *
 * Line order: base lines, bundle discount, adjustments (offering-level first,
 * then selected options', stable-sorted by `order`), minimum-spend top-up.
 * All arithmetic is exact (bigint fractions); each line rounds to integer
 * cents once, half away from zero. Discounts clamp so the running
 * subtotal never drops below zero; tax is derived once from
 * `business.taxRateMicros` over max(0, Σ taxable lines). Running sums must stay
 * safe integers — overflow is a `PRICING_ERROR` result, never a throw.
 *
 * Missing/non-numeric/negative quantities for per/tiered/formula/base-`per`
 * bindings and tierless quantities are `PRICING_ERROR` results too: pricing
 * fails closed rather than quote less than the catalog says.
 */
import type { Adjustment, Cents, Graph, Offering } from '../graph/types.js';
import type { PricingInput, PricingOutcome, PricingTraceEntry, QuoteLine } from '../engine/types.js';
import { evaluateCondition } from '../conditions/index.js';
import { evaluateFormula } from './formula.js';
import { formatMoney } from './format.js';
import {
  FractionError,
  type Fraction,
  compare,
  divide,
  fromInteger,
  multiply,
  parseDecimal,
  toApproxNumber,
  toCents,
} from './fraction.js';

const MINIMUM_SPEND_LINE_LABEL = 'Minimum spend';
const BUNDLE_DISCOUNT_LINE_LABEL = 'Bundle discount';

const MILLION = 1_000_000;

/** Apply a rate in millionths to an integer-cent amount, rounding half away from zero. */
function microsOfCents(cents: number, micros: number): number {
  return toCents(divide(multiply(fromInteger(cents), fromInteger(micros)), fromInteger(MILLION)));
}

interface MinimumSpendInfo {
  minimumCents: Cents;
  shortfallCents: Cents;
  mode: 'decline' | 'top_up';
}

/** A catalog that cannot be priced for this request (reported as `PRICING_ERROR`). */
class PricingError extends Error {}

function fail(node: string, message: string): never {
  throw new PricingError(`${node}: ${message}`);
}

/**
 * Resolve a quantity bound to a parameter value. Accepts numbers and plain
 * decimal strings; rejects missing, non-numeric, negative, or non-representable
 * values. Zero is allowed — it prices a $0 contribution, which is exact, not
 * an unknown.
 */
function quantityValue(owner: string, values: Readonly<Record<string, unknown>>, name: string): Fraction {
  const raw = values[name];
  if (raw === undefined || raw === null) {
    fail(owner, `requires a value for parameter '${name}' (none was provided).`);
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    fail(owner, `requires a numeric value for parameter '${name}' (got ${typeof raw}).`);
  }
  try {
    const value = parseDecimal(raw);
    if (value.numerator < 0n) {
      fail(owner, `requires a non-negative value for parameter '${name}'.`);
    }
    return value;
  } catch (error) {
    if (error instanceof PricingError) throw error;
    fail(owner, `parameter '${name}' is not a valid decimal quantity.`);
  }
}

/** Exact `cents × factor`, rounded once to integer cents. */
function multiplyCents(owner: string, cents: number, factor: Fraction): number {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    fail(owner, 'has an invalid base amount (must be a non-negative integer number of cents).');
  }
  try {
    return toCents(multiply(fromInteger(cents), factor));
  } catch (error) {
    if (error instanceof FractionError) {
      fail(owner, `produced an amount out of range (${error.code}).`);
    }
    throw error;
  }
}

/** Selected-option adjustments in group order then option order (declaration order). */
function selectedAdjustments(offering: Offering, input: PricingInput): Adjustment[] {
  const out: Adjustment[] = [];
  for (const group of offering.scope.optionGroups) {
    for (const option of group.options) {
      if (!input.context.chosenOptions.has(option.id)) continue;
      out.push(...option.adjustments);
    }
  }
  return out;
}

interface LineAccumulator {
  lines: QuoteLine[];
  trace: PricingTraceEntry[];
  /** Σ of every line so far. */
  runningCents: Cents;
  /** Σ of the taxable lines so far (may go negative; tax floors at zero). */
  taxableCents: Cents;
}

/** Append a finished line and update the running/taxable sums. */
function pushLine(
  acc: LineAccumulator,
  line: QuoteLine,
): void {
  const runningCents = acc.runningCents + line.amountCents;
  if (!Number.isSafeInteger(runningCents)) {
    fail(`Line ${line.id}`, 'pushes the running subtotal outside the safe-integer cent range.');
  }
  acc.lines.push(line);
  acc.runningCents = runningCents;
  if (line.taxable) acc.taxableCents += line.amountCents;
}

function baseLines(offering: Offering, input: PricingInput, acc: LineAccumulator): void {
  const usedIds = new Set<string>();
  for (const base of offering.scope.baseLines) {
    const id = `base:${base.offeringId}`;
    const uniqueId = usedIds.has(id) ? `${id}#${usedIds.size + 1}` : id;
    usedIds.add(id);

    const factor = base.per
      ? quantityValue(`Base line ${uniqueId}`, input.context.values, base.per)
      : fromInteger(1);
    // quantity = per value × contained count, so amountCents = unitAmountCents × quantity.
    const count = multiply(factor, fromInteger(base.quantity));
    const amountCents = multiplyCents(uniqueId, base.amountCents, count);
    pushLine(acc, {
      id: uniqueId,
      label: base.label,
      kind: 'base',
      amountCents,
      quantity: toApproxNumber(count),
      unitAmountCents: base.amountCents,
      taxable: base.taxable,
      source: { offering: base.offeringId },
    });
  }
}

/** Bundle discount line: percent of (or fixed amount off) the base lines only. */
function bundleDiscountLine(offering: Offering, acc: LineAccumulator): void {
  const bundle = offering.scope.bundleDiscount;
  if (!bundle) return;

  const baseCents = acc.lines.reduce((sum, line) => sum + line.amountCents, 0);
  const amountCents = bundle.type === 'percent'
    ? microsOfCents(baseCents, bundle.rateMicros)
    : bundle.amountCents;

  // Taxable when every base line is (it reduces those lines). Like any
  // discount it clamps against the running subtotal only.
  const taxable = acc.lines.every((line) => line.taxable);
  const appliedCents = -Math.min(amountCents, Math.max(0, acc.runningCents));

  pushLine(acc, {
    id: 'bundle_discount',
    label: BUNDLE_DISCOUNT_LINE_LABEL,
    kind: 'bundle_discount',
    amountCents: appliedCents,
    taxable,
    source: { offering: offering.id },
  });
  acc.trace.push({
    id: 'bundle_discount',
    label: BUNDLE_DISCOUNT_LINE_LABEL,
    when: 'TRUE',
    applied: true,
    amountCents: appliedCents,
    note: amountCents > -appliedCents
      ? `Clamped from ${amountCents} to ${-appliedCents} cents so the subtotal cannot go below zero.`
      : undefined,
  });
}

/**
 * The `basis: base` amount for one adjustment. An offering's own adjustments
 * (and its options') take Σ of all its base lines. In a sum-priced package, an
 * adjustment inherited from a contained product takes Σ of THAT product's base
 * lines only, so e.g. a lesson's weekend surcharge never lands on another
 * product's line. A fixed-price package has one base line (its own price),
 * which every `base` percent uses.
 */
function baseBasisCents(offering: Offering, adjustment: Adjustment, baseLinesOnly: readonly QuoteLine[]): number {
  const perProduct = adjustment.ownerOfferingId !== offering.id
    && offering.scope.baseLines.some((line) => line.offeringId !== offering.id);
  return baseLinesOnly
    .filter((line) => !perProduct || line.source.offering === adjustment.ownerOfferingId)
    .reduce((sum, line) => sum + line.amountCents, 0);
}

function adjustmentLine(
  adjustment: Adjustment,
  input: PricingInput,
  acc: LineAccumulator,
  baseCents: number,
): void {
  const owner = `Adjustment ${adjustment.id}`;
  const when = adjustment.when
    ? evaluateCondition(adjustment.when, input.context)
    : 'TRUE';
  if (when !== 'TRUE') {
    acc.trace.push({
      id: adjustment.id,
      label: adjustment.label,
      when,
      applied: false,
      amountCents: 0,
      note: when === 'UNKNOWN'
        ? 'Not applied: condition could not be decided with the current answers.'
        : 'Not applied: condition not met.',
    });
    return;
  }

  let amountCents: number;
  let quantity: number | undefined;
  let unitAmountCents: number | undefined;
  switch (adjustment.method.type) {
    case 'fixed': {
      amountCents = multiplyCents(owner, adjustment.method.amountCents, fromInteger(1));
      break;
    }
    case 'percent': {
      const basis = adjustment.method.basis === 'base' ? baseCents : acc.runningCents;
      amountCents = microsOfCents(Math.max(0, basis), adjustment.method.rateMicros);
      break;
    }
    case 'per_unit': {
      const q = quantityValue(owner, input.context.values, adjustment.method.per);
      amountCents = multiplyCents(owner, adjustment.method.amountCents, q);
      quantity = toApproxNumber(q);
      unitAmountCents = adjustment.method.amountCents;
      break;
    }
    case 'tiered': {
      const q = quantityValue(owner, input.context.values, adjustment.method.per);
      // Highest `from` first, so the highest matching tier wins when tiers overlap.
      const tier = [...adjustment.method.tiers]
        .sort((left, right) => right.from - left.from)
        .find((candidate) =>
          compare(q, parseDecimal(candidate.from)) >= 0
          && (candidate.to === undefined || compare(q, parseDecimal(candidate.to)) <= 0));
      if (!tier) {
        fail(owner, `has no tier covering the value of parameter '${adjustment.method.per}'.`);
      }
      amountCents = multiplyCents(owner, tier.amountCents, q);
      quantity = toApproxNumber(q);
      unitAmountCents = tier.amountCents;
      break;
    }
    case 'formula': {
      let value: Fraction;
      try {
        value = evaluateFormula(adjustment.method.expression, input.context.values);
      } catch (error) {
        fail(owner, `formula could not be evaluated (${error instanceof Error ? error.message : 'invalid formula'}).`);
      }
      if (value.numerator < 0n) {
        fail(owner, 'formula produced a negative amount.');
      }
      // Formula results are in major currency units; convert to cents.
      amountCents = multiplyCents(owner, 100, value);
      break;
    }
  }

  let signed = adjustment.kind === 'discount' ? -amountCents : amountCents;
  let note: string | undefined;
  if (adjustment.kind === 'discount') {
    // A discount may never push the running subtotal below zero; it may push
    // the taxable sum negative — tax then floors at zero (the taxable sum
    // itself is deliberately not clamped).
    const clamped = -Math.min(amountCents, Math.max(0, acc.runningCents));
    if (clamped !== signed) {
      note = `Clamped from ${signed} to ${clamped} cents so the subtotal cannot go below zero.`;
      signed = clamped;
    }
  }

  pushLine(acc, {
    id: adjustment.id,
    label: adjustment.label,
    kind: adjustment.kind,
    amountCents: signed,
    ...(quantity !== undefined && { quantity }),
    ...(unitAmountCents !== undefined && { unitAmountCents: adjustment.kind === 'discount' ? -unitAmountCents : unitAmountCents }),
    taxable: adjustment.taxable,
    ...(adjustment.reason !== undefined && { reason: adjustment.reason }),
    source: {
      offering: adjustment.ownerOfferingId,
      ...(adjustment.ownerOptionId !== undefined && { option: adjustment.ownerOptionId }),
      adjustment: adjustment.id,
    },
  });
  acc.trace.push({
    id: adjustment.id,
    label: adjustment.label,
    when: 'TRUE',
    applied: true,
    amountCents: signed,
    note,
  });
}

/** Compare the subtotal with the offering's minimum spend; add the top-up line in `top_up` mode. */
function applyMinimumSpend(
  offering: Offering,
  currency: string,
  acc: LineAccumulator,
): MinimumSpendInfo | undefined {
  const minimum = offering.minimumSpend;
  if (!minimum) return undefined;

  // The floor includes fees and applies after discounts.
  const shortfallCents = Math.max(0, minimum.amountCents - acc.runningCents);
  const applied = minimum.mode === 'top_up' && shortfallCents > 0;
  if (applied) {
    // Taxable when at least one base line is taxable.
    const taxable = offering.scope.baseLines.some((base) => base.taxable);
    pushLine(acc, {
      id: 'minimum_spend',
      label: MINIMUM_SPEND_LINE_LABEL,
      kind: 'minimum_spend',
      amountCents: shortfallCents,
      taxable,
      reason: `Brings the order up to the ${formatMoney(minimum.amountCents, currency)} minimum spend`,
      source: { offering: offering.id },
    });
  }
  acc.trace.push({
    id: 'minimum_spend',
    label: MINIMUM_SPEND_LINE_LABEL,
    when: 'TRUE',
    applied,
    amountCents: applied ? shortfallCents : 0,
    note: shortfallCents > 0
      ? (applied ? 'Subtotal below the minimum spend; topped up.' : 'Subtotal below the minimum spend; declined.')
      : 'Subtotal at or above the minimum spend.',
  });
  return { minimumCents: minimum.amountCents, shortfallCents, mode: minimum.mode };
}

function assertQuoteInvariants(quote: {
  lines: QuoteLine[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}): void {
  const problems: string[] = [];
  for (const line of quote.lines) {
    if (!Number.isSafeInteger(line.amountCents)) {
      problems.push(`line ${line.id} amount is not a safe integer`);
    }
  }
  const lineSum = quote.lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (lineSum !== quote.subtotalCents) {
    problems.push(`line sum ${lineSum} ≠ subtotal ${quote.subtotalCents}`);
  }
  if (!Number.isSafeInteger(quote.subtotalCents) || !Number.isSafeInteger(quote.taxCents) || !Number.isSafeInteger(quote.totalCents)) {
    problems.push('subtotal, tax and total must be safe integers');
  }
  if (quote.subtotalCents + quote.taxCents !== quote.totalCents) {
    problems.push(`subtotal ${quote.subtotalCents} + tax ${quote.taxCents} ≠ total ${quote.totalCents}`);
  }
  if (problems.length > 0) {
    throw new Error(`priceOffering invariant violation: ${problems.join('; ')}`);
  }
}

/**
 * Price one offering exactly. Returns the quote (with trace) or a
 * `PRICING_ERROR` result; never silently quotes less than the catalog says.
 */
export function priceOffering(
  graph: Graph,
  offeringId: string,
  input: PricingInput,
): PricingOutcome {
  const offering = graph.offerings[offeringId];
  const acc: LineAccumulator = {
    lines: [],
    trace: [],
    runningCents: 0,
    taxableCents: 0,
  };

  if (!offering) {
    return {
      ok: false,
      code: 'PRICING_ERROR',
      message: `Offering '${offeringId}' does not exist in the graph.`,
      trace: [],
    };
  }

  try {
    baseLines(offering, input, acc);
    // Percent `basis: 'base'` is over base lines only — capture them before
    // the bundle-discount line is appended.
    const baseLinesOnly = [...acc.lines];
    bundleDiscountLine(offering, acc);

    const ordered = [...offering.scope.adjustments, ...selectedAdjustments(offering, input)]
      .map((adjustment, index) => ({ adjustment, index }))
      .sort((left, right) =>
        left.adjustment.order - right.adjustment.order || left.index - right.index);
    for (const { adjustment } of ordered) {
      adjustmentLine(adjustment, input, acc, baseBasisCents(offering, adjustment, baseLinesOnly));
    }

    const minimumSpend = applyMinimumSpend(offering, graph.business.currency, acc);

    const taxRateMicros = graph.business.taxRateMicros;
    // A taxable discount can drive Σ taxable lines negative; the tax base
    // floors at zero.
    const taxBaseCents = Math.max(0, acc.taxableCents);
    const taxCents = taxRateMicros !== undefined && taxBaseCents > 0
      ? microsOfCents(taxBaseCents, taxRateMicros)
      : 0;
    const totalCents = acc.runningCents + taxCents;

    const quote = {
      currency: graph.business.currency,
      lines: acc.lines,
      subtotalCents: acc.runningCents,
      taxCents,
      totalCents,
    };
    assertQuoteInvariants(quote);

    return {
      ok: true,
      quote,
      ...(minimumSpend !== undefined && { minimumSpend }),
      trace: acc.trace,
    };
  } catch (error) {
    if (error instanceof PricingError || error instanceof FractionError) {
      return {
        ok: false,
        code: 'PRICING_ERROR',
        message: error instanceof FractionError
          ? `Amount out of range (${error.code}): ${error.message}`
          : error.message,
        trace: acc.trace,
      };
    }
    throw error;
  }
}
