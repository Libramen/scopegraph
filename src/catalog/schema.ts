/**
 * Catalog authoring format — what humans and agents write.
 *
 * A catalog is a directory:
 *   catalog/business.yaml           → BusinessInput
 *   catalog/offerings/<id>.yaml     → OfferingInput (the offering id is the file name)
 *
 * This schema checks SHAPE only. Everything that needs cross-references
 * (does `extras.photos` exist? is `participants` a declared parameter?)
 * is checked by the compiler, which reports path-anchored diagnostics.
 *
 * Conventions:
 * - Money is written in major currency units (e.g. 64 or 12.50) and compiled to
 *   integer minor units (cents). At most two decimal places.
 * - Percentages are written as 0–100 (e.g. 15 means 15%).
 * - Keys (parameters, facts, option groups, options, rules, adjustments) are
 *   lower snake_case. Offering ids (file names) may also use hyphens.
 */
import { z } from 'zod';

/** Parameter / fact / group / option / rule / adjustment key. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Offering id (file name without extension). */
export const OFFERING_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Names the engine derives itself or that the condition grammar uses. A
 * parameter or fact may not use any of these.
 */
export const RESERVED_NAMES = [
  // condition grammar
  'all',
  'any',
  'not',
  'selected',
  // top-level request input
  'date',
  // date-derived values (computed from the requested date)
  'dayOfWeek',
  'weekday',
  'isWeekend',
  'leadTimeHours',
  'leadTimeDays',
  // season-derived values (computed from business.yaml seasons)
  'isPeak',
  'isOffPeak',
  'season', // name of the first matching season, or 'none' when a date is given and no season matches
] as const;

const Key = z
  .string()
  .regex(KEY_PATTERN, 'use lower snake_case: a-z, 0-9 and "_", starting with a letter');
const OfferingId = z
  .string()
  .regex(OFFERING_ID_PATTERN, 'use lowercase letters, digits, "_" or "-", starting with a letter');

const Money = z
  .number()
  .finite()
  .nonnegative()
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'money allows at most 2 decimal places');

const Percent = z.number().finite().min(0).max(100);

const Scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
export type Scalar = z.infer<typeof Scalar>;

/** `YYYY-MM-DD` (one-off) or `MM-DD` (recurs every year). */
const SeasonDate = z
  .string()
  .regex(/^(\d{4}-)?\d{2}-\d{2}$/, 'use YYYY-MM-DD (one-off) or MM-DD (every year)');

const Weekday = z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/**
 * Condition shorthand. Grammar (validated by the compiler, not here):
 *
 *   { <name>: <scalar> }                 equals
 *   { <name>: [a, b] }                   is one of
 *   { <name>: { gt: 5, lte: 10 } }        comparisons (several keys = all must hold)
 *        ops: eq neq gt gte lt lte in not_in contains matches exists
 *   { selected: "<group>.<option>" }     that option is selected
 *   { selected: "<group>" }              anything in that group is selected
 *   { all: [c1, c2] } { any: [c1, c2] } { not: c }
 *   several top-level keys in one object = all must hold
 *
 * <name> is a parameter of the offering, a fact declared in business.yaml, or
 * a derived value (dayOfWeek, weekday, isWeekend, leadTimeHours, leadTimeDays,
 * isPeak, isOffPeak, season).
 */
const ConditionInput = z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, {
  message: 'a condition needs at least one key',
});
export type ConditionInput = z.infer<typeof ConditionInput>;

// ─── Business ────────────────────────────────────────────────────────────────

const FactInput = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string().trim().max(1000).optional(),
    /**
     * When true and the fact is missing at evaluation time, the request is
     * blocked (FACTS_UNAVAILABLE) instead of treating rules that read it as
     * undecided. Use for facts that guard safety or legality.
     */
    required: z.boolean().default(false),
  })
  .strict();
export type FactInput = z.infer<typeof FactInput>;

export const SeasonInput = z
  .object({
    name: Key,
    kind: z.enum(['peak', 'off_peak', 'custom']),
    from: SeasonDate.optional(),
    to: SeasonDate.optional(),
    days: z.array(Weekday).min(1).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();
export type SeasonInput = z.infer<typeof SeasonInput>;

export const BusinessInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    website: z.string().url().optional(),
    /** ISO 4217, one currency per catalog. */
    currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD').default('USD'),
    /** IANA timezone used for date-derived values and seasons. */
    timezone: z.string().default('UTC'),
    /** Sales tax as a percentage, applied to taxable quote lines. */
    taxRate: Percent.optional(),
    /** Values your server supplies at request time (see src/extend/facts.ts). */
    facts: z.record(Key, FactInput).optional(),
    seasons: z.array(SeasonInput).optional(),
    /**
     * What buyer agents see before scoping. progressive (default): an
     * overview per offering, then one question at a time; menu: every
     * question and add-on up front in describe_offering.
     */
    disclosure: z.enum(['progressive', 'menu']).default('progressive'),
    /**
     * What happens after a request qualifies. `url` is an absolute http(s)
     * URL template (checked by the compiler); supported placeholders:
     * {offering} {total} {total_cents} {currency} {params} {business}
     * ({params} = URL-encoded answers, selections and date).
     */
    handoff: z
      .object({
        url: z.string().min(1).optional(),
        message: z.string().max(1000).optional(),
      })
      .strict()
      .optional(),
    /**
     * Payment settings (used only when the server has Stripe configured).
     * confirmation: owner_approves (default) holds the card and charges only
     * when the owner approves; instant charges immediately (and enables MPP).
     */
    payments: z
      .object({
        confirmation: z.enum(['owner_approves', 'instant']).default('owner_approves'),
        /** Hours the owner has to approve before the hold is released (1–96). */
        approvalWindowHours: z.number().int().min(1).max(96).default(24),
        /** Minutes a quote stays payable (30–240). */
        quoteTtlMinutes: z.number().int().min(30).max(240).default(30),
        /** Where the hosted payment page returns the buyer; `{order}` placeholder. */
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type BusinessInput = z.infer<typeof BusinessInput>;

// ─── Offering parts ──────────────────────────────────────────────────────────

export const ParameterInput = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'time', 'datetime', 'select', 'multiselect']),
    /** Question text shown to the buyer. Defaults to the humanized key. */
    label: z.string().min(1).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    /**
     * Required parameters are always asked. Optional parameters are asked only
     * when a rule (or a pricing condition on a `role: fact` parameter) needs
     * their value to decide.
     */
    required: z.boolean().default(true),
    /** Allowed values for select / multiselect. */
    options: z
      .array(z.union([z.string().min(1), z.object({ value: z.string().min(1), label: z.string().optional() }).strict()]))
      .min(1)
      .optional(),
    /** Numeric bounds (number/integer) or length bounds (string). */
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /**
     * Regular expression a string answer must match (max 256 chars; no
     * backreferences or nested quantifiers — rejected by the compiler).
     */
    pattern: z.string().max(256).optional(),
    default: z.union([Scalar, z.array(z.string())]).optional(),
    /**
     * quantity — a count used for per-unit pricing (guests, hours, nights).
     * fact     — something about the site that a price depends on (e.g. "is
     *            there parking on site?"); asked only when pricing needs it.
     */
    role: z.enum(['quantity', 'fact']).optional(),
    /** Never asked of the buyer; the value comes from `default`. */
    internal: z.boolean().optional(),
  })
  .strict();
export type ParameterInput = z.infer<typeof ParameterInput>;

/**
 * A price as an object: `{ amount: 64, per: participants }` (amount × the
 * value of parameter `per`), or `{ amount: 450 }` (flat — same as `price: 450`).
 */
export const PriceObject = z.object({ amount: Money, per: Key.optional() }).strict();

/**
 * A price adjustment. Exactly one method:
 *   amount                 fixed amount
 *   percent                percentage of the subtotal (basis: running | base)
 *   amount + per           amount × value of parameter `per`
 *   tiers  + per           unit amount picked by the tier the quantity falls in, × quantity
 *   formula                arithmetic over parameter names; result in currency units
 * `kind` decides the sign and default ordering: discounts subtract, everything else adds.
 */
export const AdjustmentInput = z
  .object({
    id: Key.optional(),
    label: z.string().min(1).max(200),
    kind: z.enum(['addon', 'surcharge', 'discount', 'fee']),
    when: ConditionInput.optional(),
    amount: Money.optional(),
    percent: Percent.optional(),
    per: Key.optional(),
    tiers: z
      .array(
        z
          .object({
            from: z.number().finite().nonnegative(),
            to: z.number().finite().positive().optional(),
            amount: Money,
          })
          .strict(),
      )
      .min(1)
      .optional(),
    formula: z.string().min(1).max(2048).optional(),
    /** For percent: `running` (default) = subtotal so far; `base` = base price lines only. */
    basis: z.enum(['running', 'base']).optional(),
    /** Absent = taxable. */
    taxable: z.boolean().optional(),
    /** Shown on the quote line so the buyer sees why. */
    reason: z.string().max(200).optional(),
    /** Calculation order (lower first). Defaults: addon 100, discount 200, surcharge 300, fee 400. */
    order: z.number().int().optional(),
  })
  .strict();
export type AdjustmentInput = z.infer<typeof AdjustmentInput>;

const OptionInput = z
  .object({
    label: z.string().min(1).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    /** Add-on price charged when this option is selected. */
    price: z.union([Money, PriceObject]).optional(),
    /**
     * Full adjustments applied only while this option is selected — use for
     * anything `price` can't say (e.g. a per-paddler discount for a tandem).
     * No `when` is needed for the selection itself.
     */
    pricing: z.array(AdjustmentInput).optional(),
    taxable: z.boolean().optional(),
  })
  .strict();
export type OptionInput = z.infer<typeof OptionInput>;

export const OptionGroupInput = z
  .object({
    label: z.string().min(1).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    /** single = pick one; multi = pick any number (bounded by min/max). */
    mode: z.enum(['single', 'multi']).default('single'),
    /** Required groups are always asked; optional groups are only asked when a rule requires them. */
    required: z.boolean().default(false),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
    /** Either a list of keys, or a map of key → details. */
    options: z.union([z.array(Key).min(1), z.record(Key, OptionInput.nullable())]),
  })
  .strict();
export type OptionGroupInput = z.infer<typeof OptionGroupInput>;

/**
 * A rule: `when` (optional; absent = always) plus exactly one effect.
 *   block:   "<message>"           refuse the request
 *   require: "<group>[.<option>]"  that group/option must be selected (asked first)
 *   exclude: "<group>[.<option>]"  that group/option must not be selected
 *   ask:     "<param|group>"       only ask this step while `when` holds
 */
export const RuleInput = z
  .object({
    id: Key.optional(),
    description: z.string().trim().max(1000).optional(),
    when: ConditionInput.optional(),
    block: z.string().min(1).max(500).optional(),
    require: z.string().min(1).optional(),
    exclude: z.string().min(1).optional(),
    ask: z.string().min(1).optional(),
    /** Message for require/exclude violations. */
    message: z.string().max(500).optional(),
    /** Lower runs first. */
    priority: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type RuleInput = z.infer<typeof RuleInput>;

const ContainsInput = z.union([
  OfferingId,
  z.object({ offering: OfferingId, quantity: z.number().int().min(1).default(1) }).strict(),
]);

export const OfferingInput = z
  .object({
    kind: z.enum(['product', 'package']).default('product'),
    name: z.string().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    category: z.string().max(100).optional(),
    keywords: z.array(z.string().min(1)).default([]),
    status: z.enum(['active', 'paused', 'archived']).default('active'),
    /** false = only sold inside packages, never on its own. */
    bookable: z.boolean().default(true),
    /**
     * Base price. Products: required. Packages: a fixed package price; omit to
     * charge the sum of the contained products (optionally with `discount`).
     */
    price: z.union([Money, PriceObject]).optional(),
    /** Is the base price taxable? Absent = taxable. */
    taxable: z.boolean().optional(),
    /** Packages only: the products inside. */
    contains: z.array(ContainsInput).optional(),
    /** Packages priced as a sum only: bundle discount (exactly one of percent / amount). */
    discount: z.object({ percent: Percent.optional(), amount: Money.optional() }).strict().optional(),
    /** Whether the buyer must give a date (ISO 8601 date or date-time). */
    date: z.enum(['none', 'optional', 'required']).default('none'),
    /** Refuse dates closer than this many hours from now. */
    minNoticeHours: z.number().finite().nonnegative().optional(),
    /** Questions for the buyer, asked in the order written. */
    ask: z.record(Key, ParameterInput).optional(),
    /** Option groups, asked in the order written. */
    choose: z.record(Key, OptionGroupInput).optional(),
    rules: z.array(RuleInput).optional(),
    pricing: z.array(AdjustmentInput).optional(),
    minimumSpend: z
      .object({ amount: Money.refine((v) => v > 0, 'minimum spend must be positive'), mode: z.enum(['decline', 'top_up']) })
      .strict()
      .optional(),
  })
  .strict();
export type OfferingInput = z.infer<typeof OfferingInput>;

/** A loaded (but not yet compiled) catalog. */
export interface CatalogInput {
  business: { file: string; data: unknown };
  offerings: Array<{ id: string; file: string; data: unknown }>;
}
