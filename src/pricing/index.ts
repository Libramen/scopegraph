/**
 * Pricing module — exact quote assembly and money formatting.
 *
 * - `priceOffering`: exact quote for one offering (bigint fractions, single
 *   half-away-from-zero rounding per line, tax from `business.taxRateMicros`).
 * - `parseFormula`: validates bounded arithmetic over snake_case parameter
 *   names.
 * - `formatMoney` / `choicePriceHint`: buyer-facing strings.
 */
export { priceOffering } from './priceOffering.js';
export { parseFormula } from './formula.js';
export type { FormulaResult } from './formula.js';
export { choicePriceHint, formatMoney, quantityUnit } from './format.js';
export type { Fraction } from './fraction.js';
