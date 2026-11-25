/**
 * Engine API — request in, one of five outcomes out. Pure and synchronous:
 * no I/O, no hidden clock (pass `now`).
 */
import type { Cents, Graph, ParameterType, RuleEffect, Truth, Value } from '../graph/types.js';

export interface ScopeRequest {
  offering: string;
  /** Parameter answers keyed by parameter name. Resubmit all answers every call. */
  answers?: Record<string, Value>;
  /** Option selections keyed by group key: an option key, or a list for multi groups. */
  selections?: Record<string, string | string[]>;
  /** ISO 8601 date (`2026-07-04`) or date-time (`2026-07-04T09:00:00-07:00`). */
  date?: string;
  /**
   * TRUSTED server-side facts. Never forward caller-supplied facts from a
   * public surface — buyers could forge them.
   */
  facts?: Record<string, Value>;
}

/**
 * Who reads the result. `owner` (the CLI, scenarios, payment re-checks) gets
 * full detail. `buyer` (public surfaces under `disclosure: progressive`) gets
 * `invalid` messages without allowed values or bounds, has unknown answer and
 * selection names ignored (trace warning) instead of rejected, and a
 * `summary.answers` limited to what the buyer supplied.
 */
export type Audience = 'owner' | 'buyer';

export interface EvaluateOptions {
  /** Defaults to `new Date()`; pass explicitly for deterministic results. */
  now?: Date;
  /** Include the explanation trace (default true). Public surfaces strip it. */
  trace?: boolean;
  /** Default `owner`. */
  audience?: Audience;
}

// ─── Questions ───────────────────────────────────────────────────────────────

export type QuestionReason =
  | 'date' // the offering needs a date
  | 'required' // a required parameter is unanswered
  | 'rule_dependency' // a rule cannot be decided without this answer
  | 'pricing_fact' // a pricing adjustment depends on this fact-role parameter
  | 'required_choice' // a required option group has too few selections
  | 'rule_requirement' // a rule requires something from this group
  | 'pricing_input'; // an applicable price line needs this quantity / formula input

export interface ParameterQuestion {
  kind: 'parameter';
  key: string;
  label: string;
  description?: string;
  type: ParameterType;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  pattern?: string;
  default?: Value;
  /**
   * describe_offering only: asked only when earlier answers make it relevant
   * (an `ask` rule), so agents should not ask it up front.
   */
  conditional?: true;
}

export interface ChoiceQuestion {
  kind: 'choice';
  key: string;
  label: string;
  description?: string;
  mode: 'single' | 'multi';
  minSelections: number;
  maxSelections?: number;
  options: Array<{ key: string; label: string; description?: string; priceHint?: string }>;
  /** Set when a rule requires one specific option of this group. */
  requiredOption?: string;
  /** The rule's message, when asked because of a rule requirement. */
  message?: string;
  /** describe_offering only: offered only when earlier answers make it relevant (an `ask` rule). */
  conditional?: true;
}

export interface DateQuestion {
  kind: 'date';
  key: 'date';
  label: string;
  required: boolean;
  minNoticeHours?: number;
}

export type Question = ParameterQuestion | ChoiceQuestion | DateQuestion;

// ─── Quote ───────────────────────────────────────────────────────────────────

export interface QuoteLine {
  id: string;
  label: string;
  kind: 'base' | 'addon' | 'surcharge' | 'discount' | 'fee' | 'bundle_discount' | 'minimum_spend';
  /** Signed: discounts are negative. */
  amountCents: Cents;
  quantity?: number;
  unitAmountCents?: Cents;
  taxable: boolean;
  reason?: string;
  source: { offering: string; option?: string; adjustment?: string };
}

/** Invariants: Σ lines.amountCents === subtotalCents; subtotalCents + taxCents === totalCents. */
export interface Quote {
  currency: string;
  lines: QuoteLine[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

// ─── Trace (explanations; stripped on public surfaces) ──────────────────────

export interface RuleTraceEntry {
  id: string;
  offering: string;
  effect: RuleEffect['kind'];
  when: Truth;
  /** True when the effect applied (block fired, require/exclude violated, ask open). */
  fired: boolean;
  /** Names the condition referenced that had no value. */
  unknownRefs: string[];
}

export interface PricingTraceEntry {
  id: string;
  label: string;
  when: Truth;
  applied: boolean;
  amountCents?: Cents;
  note?: string;
}

export interface Trace {
  /** Answers + defaults + facts + derived values the evaluation used. */
  values: Record<string, Value>;
  /** Why the returned question (if any) was chosen, and what else was pending. */
  questionReason?: QuestionReason;
  pendingQuestions: string[];
  rules: RuleTraceEntry[];
  pricing: PricingTraceEntry[];
  warnings: string[];
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

interface OutcomeBase {
  offering: string;
  trace?: Trace;
}

export interface Unavailable extends OutcomeBase {
  status: 'unavailable';
  code: 'NOT_FOUND' | 'NOT_ACTIVE' | 'NOT_BOOKABLE' | 'CONTENTS_UNAVAILABLE';
  message: string;
}

export interface InvalidInput extends OutcomeBase {
  status: 'invalid';
  errors: Array<{
    field: string;
    code: 'UNKNOWN_FIELD' | 'INVALID_VALUE' | 'UNKNOWN_OPTION' | 'TOO_MANY_SELECTIONS' | 'INVALID_DATE';
    message: string;
  }>;
}

export interface NeedsInput extends OutcomeBase {
  status: 'needs_input';
  question: Question;
  reason: QuestionReason;
}

export interface Blocked extends OutcomeBase {
  status: 'blocked';
  reasons: Array<{
    code: 'RULE' | 'MINIMUM_SPEND' | 'DATE_IN_PAST' | 'DATE_TOO_SOON' | 'FACTS_UNAVAILABLE' | 'PRICING_ERROR';
    message: string;
    ruleId?: string;
  }>;
}

/** A request as it qualified: answers by parameter name, selections as option-key lists. */
export interface NormalizedRequest {
  answers: Record<string, Value>;
  selections: Record<string, string[]>;
  date?: string;
}

export interface Qualified extends OutcomeBase {
  status: 'qualified';
  quote: Quote;
  /**
   * The request that qualified. Owner audience: every answer incl. defaults.
   * Buyer audience: only the answers the buyer supplied that still apply
   * (after closed-gate drops); defaults are not echoed.
   */
  summary: NormalizedRequest;
  /**
   * Buyer audience only: the full normalized request (answers incl. defaults),
   * which the stored quote freezes. Never public. Owner results omit it:
   * their `summary` is already the full request.
   */
  request?: NormalizedRequest;
  /**
   * Optional add-ons the buyer could still choose (informational: the quote is
   * for the current selection; re-scope with `selections` to add one). Omitted
   * when there are none.
   */
  addOns?: AddOnGroup[];
}

/** An optional option group offered on a qualified result: labels and unconditional price hints only. */
export interface AddOnGroup {
  key: string;
  label: string;
  mode: 'single' | 'multi';
  options: Array<{ key: string; label: string; priceHint?: string }>;
}

export type ScopeResult = Unavailable | InvalidInput | NeedsInput | Blocked | Qualified;

// ─── Contracts between modules ───────────────────────────────────────────────

/** Input to `evaluateCondition` (src/conditions). */
export interface ConditionContext {
  /** Answers, defaults, facts and derived values by name. Missing = unknown. */
  values: Record<string, Value | undefined>;
  /** Selected option ids (`<group>.<option>`). */
  chosenOptions: ReadonlySet<string>;
  /** Group key → selected option ids. */
  selectedByGroup: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Input to `priceOffering` (src/pricing). Conditions are evaluated with the same context. */
export interface PricingInput {
  context: ConditionContext;
}

export type PricingOutcome =
  | {
      ok: true;
      quote: Quote;
      /** Present when a minimum spend applies: shortfall before any top-up. */
      minimumSpend?: { minimumCents: Cents; shortfallCents: Cents; mode: 'decline' | 'top_up' };
      trace: PricingTraceEntry[];
    }
  | { ok: false; code: 'PRICING_ERROR'; message: string; trace: PricingTraceEntry[] };

/** Public listing / description (for list_offerings / describe_offering). */
export interface OfferingListing {
  id: string;
  kind: 'product' | 'package';
  name: string;
  description?: string;
  category?: string;
  keywords: string[];
  /** Human-readable "from" price, e.g. "$64.00 × participants". */
  priceFrom?: string;
}

export interface OfferingDescription extends OfferingListing {
  currency: string;
  /** The business's IANA timezone: dates, notice and weekend/season rules use its local time. */
  timezone: string;
  date: 'none' | 'optional' | 'required';
  minNoticeHours?: number;
  contains?: Array<{ offering: string; name: string; quantity: number }>;
  /** Buyer-facing questions (internal ones omitted), in ask order. */
  questions: ParameterQuestion[];
  choices: ChoiceQuestion[];
}

/** What describe_offering shows under `disclosure: progressive`: no questions, no choices. */
export interface OfferingOverview extends Omit<OfferingDescription, 'questions' | 'choices'> {
  disclosure: 'progressive';
  /** How to continue: scope the offering; it asks one question at a time. */
  next: string;
}

/** describe_offering / GET /api/offerings/:id for buyers, per the business's `disclosure`. */
export type BuyerOfferingDescription = OfferingOverview | (OfferingDescription & { disclosure: 'menu' });

export type Evaluate = (graph: Graph, request: ScopeRequest, options?: EvaluateOptions) => ScopeResult;
