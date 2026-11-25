/**
 * Buyer-facing money formatting for quotes and choice price hints.
 *
 * `formatMoney` uses Intl with the currency's real minor-unit count (USD/EUR
 * 2, JPY 0, KWD/BHD 3), so integer minor units always format exactly.
 * `choicePriceHint` reads a short "+$20.00" note off an option's own first
 * unconditional fixed, per-unit or percent adjustment. It is never computed
 * from a quote. Conditional (`when`), tiered/formula and fee-kind entries get
 * no hint.
 */
import type { Option } from '../graph/types.js';
import { minorUnitDigits } from './currency.js';

/**
 * Format integer minor units (`cents`) in `currency`, e.g. 12345/USD →
 * "$123.45", 12345/JPY → "¥12,345", 1235/KWD → "KD1.235". Locale en-US.
 */
export function formatMoney(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`formatMoney expects a safe integer number of minor units, got ${cents}.`);
  }
  const digits = minorUnitDigits(currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 10 ** digits);
}

/** Percent value of a rate in millionths for a hint: 150_000 → "15", 85_000 → "8.5". */
function percentFromMicros(rateMicros: number): string {
  const percent = rateMicros / 10_000;
  return `${percent}`;
}

/**
 * The price hint shown next to one option, from its adjustments in order:
 * fixed → "+$20.00" / "-$20.00" (discounts negative),
 * per_unit → "+$20.00 × <quantity parameter name>",
 * percent → "+15%" / "-15%". Amounts of zero, fee-kind and conditional
 * (`when`) adjustments, and tiered/formula methods produce no hint (`undefined`).
 */
export function choicePriceHint(option: Option, currency: string): string | undefined {
  for (const adjustment of option.adjustments) {
    // A fee is not what the choice itself costs, so it is skipped. A `when`
    // entry applies only to some buyers (and may read server facts), so it is
    // never shown as the option's price.
    if (adjustment.kind === 'fee' || adjustment.when !== undefined) continue;
    const reduction = adjustment.kind === 'discount';
    if (adjustment.method.type === 'fixed') {
      if (adjustment.method.amountCents === 0) continue;
      const sign = reduction || adjustment.method.amountCents < 0 ? '-' : '+';
      return `${sign}${formatMoney(Math.abs(adjustment.method.amountCents), currency)}`;
    }
    if (adjustment.method.type === 'per_unit') {
      const { amountCents, per } = adjustment.method;
      if (amountCents === 0) continue;
      const sign = reduction || amountCents < 0 ? '-' : '+';
      return `${sign}${formatMoney(Math.abs(amountCents), currency)} × ${quantityUnit(per)}`;
    }
    if (adjustment.method.type === 'percent') {
      if (adjustment.method.rateMicros === 0) continue;
      const sign = reduction || adjustment.method.rateMicros < 0 ? '-' : '+';
      return `${sign}${percentFromMicros(Math.abs(adjustment.method.rateMicros))}%`;
    }
    // tiered / formula → no short hint; a later adjustment may still have one.
  }
  return undefined;
}

/**
 * How a per-unit quantity reads in price wording: the parameter name with
 * underscores as spaces ("$64.00 × participants", "+$20.00 × guide hours").
 * The parameter *label* is a question ("How many surfers?"), so it is not used.
 */
export function quantityUnit(parameterName: string): string {
  return parameterName.replace(/_/g, ' ');
}
