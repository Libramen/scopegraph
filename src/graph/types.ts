/**
 * Compiled graph — what the compiler produces and the engine consumes.
 *
 * Everything is resolved: references point at things that exist, money is in
 * integer minor units, percentages are in parts-per-million, and every
 * offering carries a pre-flattened `scope` so the engine never walks
 * `contains` itself.
 */

/** Integer minor currency units (cents for USD). */
export type Cents = number;

/** Answer / fact / derived value. */
export type Value = string | number | boolean | string[];

// ─── Conditions (the `when:` grammar, evaluated with Kleene three-valued logic) ──

/**
 * Condition operators — the words of the `when:` grammar. Leaves compare a
 * value (`eq` … `exists`; `exists` carries `value: true | false`) or test a
 * selection (`selected`); `all` / `any` / `not` combine `conditions`.
 */
export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'matches'
  | 'exists'
  | 'selected'
  | 'all'
  | 'any'
  | 'not';

/**
 * What a leaf reads (compound nodes have no `ref`):
 * - parameter  `name` = parameter name (askable)
 * - fact       `name` = fact declared in business.yaml (never asked)
 * - derived    `name` = derived value such as `isWeekend` (never asked)
 * - option     `name` = option id `<group>.<option>`, or a group key
 *              (no dot) meaning "anything in that group"
 */
export type ConditionRef = 'parameter' | 'fact' | 'derived' | 'option';

export interface Condition {
  ref?: ConditionRef;
  name?: string;
  op: ConditionOp;
  value?: string | number | boolean | string[] | number[];
  conditions?: Condition[];
}

/** Three-valued result of a condition. */
export type Truth = 'TRUE' | 'FALSE' | 'UNKNOWN';

// ─── Business ────────────────────────────────────────────────────────────────

export interface FactDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required: boolean;
}

export interface Season {
  name: string;
  kind: 'peak' | 'off_peak' | 'custom';
  /** `YYYY-MM-DD` or `MM-DD` (recurring). Inclusive. A recurring range may wrap the year end. */
  from?: string;
  to?: string;
  /** 0 = Sunday … 6 = Saturday. */
  days?: number[];
}

export interface Business {
  name: string;
  description?: string;
  website?: string;
  currency: string;
  timezone: string;
  /** Tax rate in millionths (8.5% → 85_000). Absent = no tax. */
  taxRateMicros?: number;
  facts: Record<string, FactDef>;
  seasons: Season[];
  /** What buyer agents see before scoping: an overview (progressive) or every question and add-on (menu). */
  disclosure: 'progressive' | 'menu';
  handoff?: { url?: string; message?: string };
  payments: {
    confirmation: 'owner_approves' | 'instant';
    approvalWindowHours: number;
    quoteTtlMinutes: number;
    successUrl?: string;
    cancelUrl?: string;
  };
}

// ─── Offering parts ──────────────────────────────────────────────────────────

export type ParameterType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'select'
  | 'multiselect';

export interface Parameter {
  name: string;
  label: string;
  description?: string;
  type: ParameterType;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  pattern?: string;
  default?: Value;
  role?: 'quantity' | 'fact';
  internal: boolean;
  /** Offering that declared it (packages inherit from contained products). */
  ownerOfferingId: string;
}

export interface Option {
  /** `<group>.<option>` — unique within the offering's scope. */
  id: string;
  key: string;
  groupKey: string;
  label: string;
  description?: string;
  /** Applied only when this option is selected (no extra `when` needed). */
  adjustments: Adjustment[];
}

export interface OptionGroup {
  key: string;
  label: string;
  description?: string;
  mode: 'single' | 'multi';
  required: boolean;
  /** For required groups ≥ 1. */
  minSelections: number;
  /** `single` → 1. Absent = unbounded. */
  maxSelections?: number;
  options: Option[];
}

/** What a `require` / `exclude` rule names: one option, or a whole group. */
export interface SelectionTarget {
  type: 'option' | 'group';
  id: string;
}

export type RuleEffect =
  | { kind: 'block'; message: string }
  | { kind: 'require'; target: SelectionTarget; message?: string }
  | { kind: 'exclude'; target: SelectionTarget; message?: string }
  /** Ask `target` only while the rule's `when` holds. */
  | { kind: 'ask'; target: { type: 'parameter' | 'group'; id: string } };

export interface Rule {
  /** `<offering>.<key>` where key is the author `id` or `rule<N>` (1-based). Unique in the graph. */
  id: string;
  description?: string;
  when?: Condition;
  effect: RuleEffect;
  /** Lower runs first; ties keep declaration order. */
  priority: number;
  active: boolean;
  ownerOfferingId: string;
}

export type AdjustmentMethod =
  | { type: 'fixed'; amountCents: Cents }
  | { type: 'percent'; rateMicros: number; basis: 'running' | 'base' }
  | { type: 'per_unit'; amountCents: Cents; per: string }
  | { type: 'tiered'; per: string; tiers: Array<{ from: number; to?: number; amountCents: Cents }> }
  /** Formula result is in major currency units; `dependencies` are parameter names. */
  | { type: 'formula'; expression: string; dependencies: string[] };

export interface Adjustment {
  /** `<offering>.<key>` (key = author `id` or `pricing<N>`), or `<offering>.<group>.<option>.price`. Unique in the graph. */
  id: string;
  label: string;
  kind: 'addon' | 'surcharge' | 'discount' | 'fee';
  method: AdjustmentMethod;
  when?: Condition;
  taxable: boolean;
  reason?: string;
  order: number;
  ownerOfferingId: string;
  /** Set for option-owned add-ons; applied only when that option is selected. */
  ownerOptionId?: string;
}

/** A base price line contribution before adjustments. */
export interface BaseLine {
  /** Offering whose base price this is (the package itself, or a contained product). */
  offeringId: string;
  label: string;
  amountCents: Cents;
  /** Per-unit base: multiply by this parameter's value. */
  per?: string;
  /** Times this line is counted (contained-product quantity). */
  quantity: number;
  taxable: boolean;
}

/**
 * The pre-flattened evaluation scope of an offering.
 * - Products: their own parameters / rules / adjustments.
 * - Packages: own first, then each contained product's in `contains` order,
 *   de-duplicated by name/id. Option groups are NEVER flattened — a package
 *   only offers its own option groups.
 */
export interface OfferingScope {
  parameters: Parameter[];
  optionGroups: OptionGroup[];
  rules: Rule[];
  /** Offering-level adjustments (option-owned ones live on their Option). */
  adjustments: Adjustment[];
  baseLines: BaseLine[];
  /** Packages priced as a sum may carry a bundle discount. */
  bundleDiscount?: { type: 'percent'; rateMicros: number } | { type: 'fixed'; amountCents: Cents };
  /** Products contained in this package that are not active (package becomes unavailable). */
  inactiveContents: string[];
}

export interface Offering {
  id: string;
  kind: 'product' | 'package';
  name: string;
  description?: string;
  category?: string;
  keywords: string[];
  status: 'active' | 'paused' | 'archived';
  bookable: boolean;
  contains: Array<{ offeringId: string; quantity: number }>;
  date: 'none' | 'optional' | 'required';
  minNoticeHours?: number;
  minimumSpend?: { amountCents: Cents; mode: 'decline' | 'top_up' };
  scope: OfferingScope;
}

export interface Graph {
  business: Business;
  /** Keyed by offering id, in file-name order. */
  offerings: Record<string, Offering>;
}
