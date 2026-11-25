/**
 * Graph fixture builders for tests (any module). Build compiled `Graph`s
 * directly in TypeScript without going through the YAML compiler.
 *
 *   const g = graph([
 *     offering('lesson', {
 *       date: 'required',
 *       scope: {
 *         parameters: [param('participants', { type: 'integer', role: 'quantity', min: 1 })],
 *         optionGroups: [group('board', ['soft', 'hard'], { required: true })],
 *         rules: [rule('too_young', { kind: 'block', message: 'No' }, { when: p('age', 'lt', 10) })],
 *         baseLines: [baseLine(7300, { per: 'participants' })],
 *       },
 *     }),
 *   ]);
 *
 * Owner ids (`ownerOfferingId`, base line `offeringId`) left empty are filled
 * in with the offering's id by `offering()`.
 */
import type {
  Adjustment,
  AdjustmentMethod,
  BaseLine,
  Business,
  Condition,
  ConditionOp,
  Graph,
  Offering,
  OfferingScope,
  Option,
  OptionGroup,
  Parameter,
  Rule,
  RuleEffect,
} from '../graph/types.js';

export function business(overrides: Partial<Business> = {}): Business {
  return {
    name: 'Test Co',
    currency: 'USD',
    timezone: 'UTC',
    facts: {},
    seasons: [],
    disclosure: 'progressive',
    payments: { confirmation: 'owner_approves', approvalWindowHours: 24, quoteTtlMinutes: 30 },
    ...overrides,
  };
}

export function param(name: string, overrides: Partial<Parameter> = {}): Parameter {
  return {
    name,
    label: name,
    type: 'string',
    required: true,
    internal: false,
    ownerOfferingId: '',
    ...overrides,
  };
}

/** Options as keys, or as partial options with at least `key`. Ids are `<group>.<key>`. */
export function group(
  key: string,
  options: Array<string | (Partial<Option> & { key: string })>,
  overrides: Partial<OptionGroup> = {},
): OptionGroup {
  const mode = overrides.mode ?? 'single';
  const required = overrides.required ?? false;
  return {
    key,
    label: key,
    mode,
    required,
    minSelections: required ? 1 : 0,
    ...(mode === 'single' ? { maxSelections: 1 } : {}),
    ...overrides,
    options: options.map((o) => {
      const spec = typeof o === 'string' ? { key: o } : o;
      return { id: `${key}.${spec.key}`, groupKey: key, label: spec.key, adjustments: [], ...spec };
    }),
  };
}

export function rule(id: string, effect: RuleEffect, overrides: Partial<Rule> = {}): Rule {
  return { id, effect, priority: 0, active: true, ownerOfferingId: '', ...overrides };
}

export function adjustment(id: string, method: AdjustmentMethod, overrides: Partial<Adjustment> = {}): Adjustment {
  return {
    id,
    label: id,
    kind: 'surcharge',
    method,
    taxable: true,
    order: 75,
    ownerOfferingId: '',
    ...overrides,
  };
}

export function baseLine(amountCents: number, overrides: Partial<BaseLine> = {}): BaseLine {
  return { offeringId: '', label: 'Base price', amountCents, quantity: 1, taxable: true, ...overrides };
}

export function offering(
  id: string,
  overrides: Partial<Omit<Offering, 'scope'>> & { scope?: Partial<OfferingScope> } = {},
): Offering {
  const { scope = {}, ...rest } = overrides;
  const own = <T extends { ownerOfferingId: string }>(x: T): T => (x.ownerOfferingId ? x : { ...x, ownerOfferingId: id });
  return {
    id,
    kind: 'product',
    name: id,
    keywords: [],
    status: 'active',
    bookable: true,
    contains: [],
    date: 'none',
    ...rest,
    scope: {
      parameters: (scope.parameters ?? []).map(own),
      optionGroups: (scope.optionGroups ?? []).map((g) => ({
        ...g,
        options: g.options.map((o) => ({ ...o, adjustments: o.adjustments.map(own) })),
      })),
      rules: (scope.rules ?? []).map(own),
      adjustments: (scope.adjustments ?? []).map(own),
      baseLines: (scope.baseLines ?? []).map((b) => (b.offeringId ? b : { ...b, offeringId: id })),
      ...(scope.bundleDiscount ? { bundleDiscount: scope.bundleDiscount } : {}),
      inactiveContents: scope.inactiveContents ?? [],
    },
  };
}

export function graph(offerings: Offering[], businessOverrides: Partial<Business> = {}): Graph {
  return { business: business(businessOverrides), offerings: Object.fromEntries(offerings.map((o) => [o.id, o])) };
}

// ─── Condition builders ──────────────────────────────────────────────────────

type LeafOp = Exclude<ConditionOp, 'all' | 'any' | 'not'>;

/** `parameter` leaf. */
export function p(name: string, op: LeafOp, value?: Condition['value']): Condition {
  return { ref: 'parameter', name, op, ...(value === undefined ? {} : { value }) };
}

/** `fact` leaf (a fact declared in business.yaml). */
export function f(name: string, op: LeafOp, value?: Condition['value']): Condition {
  return { ref: 'fact', name, op, ...(value === undefined ? {} : { value }) };
}

/** `derived` leaf (isWeekend, weekday, season, …). */
export function d(name: string, op: LeafOp, value?: Condition['value']): Condition {
  return { ref: 'derived', name, op, ...(value === undefined ? {} : { value }) };
}

/** `option` leaf: `<group>.<option>` or a group key. */
export function selected(id: string): Condition {
  return { ref: 'option', name: id, op: 'selected' };
}

export function all(...conditions: Condition[]): Condition {
  return { op: 'all', conditions };
}

export function any(...conditions: Condition[]): Condition {
  return { op: 'any', conditions };
}

export function not(condition: Condition): Condition {
  return { op: 'not', conditions: [condition] };
}
