/**
 * Currency support. The catalog compiles every money amount to 1/100 units
 * (`price: 64` → 6400), so only currencies with exactly two minor units —
 * both for display (Intl) and for charging (Stripe) — price correctly.
 * `isTwoDecimalCurrency` is the one check the compiler, `init`, `doctor` and
 * payments all share.
 */

const minorUnitDigitsCache = new Map<string, number>();

/** Number of minor units for an ISO 4217 code, per Intl (USD 2, JPY 0, KWD 3). */
export function minorUnitDigits(currency: string): number {
  const cached = minorUnitDigitsCache.get(currency);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    const resolved = new Intl.NumberFormat('en-US', { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits;
    if (resolved !== undefined && Number.isInteger(resolved) && resolved >= 0) {
      digits = resolved;
    }
  } catch {
    // unknown currency code: Intl falls back to 2 minor units
  }
  minorUnitDigitsCache.set(currency, digits);
  return digits;
}

/**
 * Currencies whose Stripe minor unit is not 1/100 (zero-decimal, three-decimal,
 * and ISK which Stripe treats as zero-decimal), even where Intl formats them
 * with two decimals.
 * Source: https://docs.stripe.com/currencies#zero-decimal and #three-decimal
 */
const STRIPE_NOT_TWO_DECIMAL: Record<string, true> = {
  BIF: true, CLP: true, DJF: true, GNF: true, JPY: true, KMF: true, KRW: true, MGA: true,
  PYG: true, RWF: true, UGX: true, VND: true, VUV: true, XAF: true, XOF: true, XPF: true,
  ISK: true,
  BHD: true, JOD: true, KWD: true, OMR: true, TND: true,
};

/** True when `currency` has exactly two minor units for both Intl and Stripe (what the catalog compiles to). */
export function isTwoDecimalCurrency(currency: string): boolean {
  const code = currency.toUpperCase();
  return STRIPE_NOT_TWO_DECIMAL[code] !== true && minorUnitDigits(code) === 2;
}

/** Why a non-two-decimal currency is refused — the same words in the compiler, `init`, `doctor` and payments. */
export function unsupportedCurrencyMessage(currency: string): string {
  return `currency '${currency.toUpperCase()}' is not supported yet: catalog money is compiled to 1/100 units, so only two-decimal currencies (USD, EUR, GBP, …) price correctly`;
}
