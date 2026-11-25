/**
 * `ask` rules: which steps are open (any TRUE `when` opens a step; UNKNOWN
 * keeps it closed), price-line inputs that are kept even behind a closed
 * step, and dropping answers and selections for closed steps until stable.
 */
import { evaluateCondition } from '../conditions/index.js';
import type { Adjustment, OfferingScope, Rule, Truth, Value } from '../graph/types.js';
import type { ConditionContext } from './types.js';

function buildContext(values: Record<string, Value>, selections: Map<string, string[]>): ConditionContext {
  const selectedByGroup = new Map<string, Set<string>>();
  for (const [key, ids] of selections) selectedByGroup.set(key, new Set(ids));
  return { values, chosenOptions: new Set([...selections.values()].flat()), selectedByGroup };
}

/**
 * Open/closed state of every step an active `ask` rule targets. A step with
 * several `ask` rules is open when any of their `when`s is TRUE; UNKNOWN keeps
 * it closed. Key: `parameter:<name>` / `group:<key>` → open?
 */
export function gateState(rules: Array<{ rule: Rule; when: Truth }>): Map<string, boolean> {
  const gates = new Map<string, boolean>();
  for (const { rule, when } of rules) {
    if (!rule.active || rule.effect.kind !== 'ask') continue;
    const key = `${rule.effect.target.type}:${rule.effect.target.id}`;
    gates.set(key, (gates.get(key) ?? false) || when === 'TRUE');
  }
  return gates;
}

export function selectedOptionAdjustments(scope: OfferingScope, ctx: ConditionContext): Adjustment[] {
  return scope.optionGroups.flatMap((g) =>
    g.options.filter((o) => ctx.chosenOptions.has(o.id)).flatMap((o) => o.adjustments),
  );
}

/**
 * Parameter names the applicable price lines read as quantities or formula
 * inputs, in line order: every base line's `per`, then per_unit / tiered
 * `per` and formula dependencies of adjustments (offering-level, then
 * selected options') whose `when` is absent or TRUE.
 */
export function pricingInputs(scope: OfferingScope, ctx: ConditionContext): string[] {
  const names: string[] = [];
  for (const line of scope.baseLines) if (line.per !== undefined) names.push(line.per);
  for (const adjustment of [...scope.adjustments, ...selectedOptionAdjustments(scope, ctx)]) {
    if (adjustment.when && evaluateCondition(adjustment.when, ctx) !== 'TRUE') continue;
    const method = adjustment.method;
    if (method.type === 'per_unit' || method.type === 'tiered') names.push(method.per);
    else if (method.type === 'formula') names.push(...method.dependencies);
  }
  return [...new Set(names)];
}

/**
 * Drop answers and selections for closed steps, recomputing the `ask` rules
 * until nothing changes (dropping an answer can close another step). A
 * dropped answer falls back to the parameter default. Answers that an
 * applicable price line needs (see `pricingInputs`) are kept even when their
 * step is closed: the price-input question is asked regardless of `ask`
 * rules, so dropping them would loop.
 * Mutates `values`, `answers` and `selections`; returns the final context.
 */
export function dropClosedGateInputs(
  scope: OfferingScope,
  values: Record<string, Value>,
  answers: Record<string, Value>,
  selections: Map<string, string[]>,
  warnings: string[],
): ConditionContext {
  let ctx = buildContext(values, selections);
  const askRules = scope.rules.filter((r) => r.active && r.effect.kind === 'ask');
  if (askRules.length === 0) return ctx;
  for (;;) {
    const gates = gateState(askRules.map((rule) => ({ rule, when: rule.when ? evaluateCondition(rule.when, ctx) : 'TRUE' })));
    const needed = new Set(pricingInputs(scope, ctx));
    let changed = false;
    for (const name of Object.keys(answers)) {
      if ((gates.get(`parameter:${name}`) ?? true) || needed.has(name)) continue;
      delete answers[name];
      const fallback = scope.parameters.find((p) => p.name === name)?.default;
      if (fallback === undefined) delete values[name];
      else values[name] = fallback;
      warnings.push(`Ignored answer "${name}": that question does not apply (closed gate).`);
      changed = true;
    }
    for (const key of [...selections.keys()]) {
      if (gates.get(`group:${key}`) ?? true) continue;
      selections.delete(key);
      warnings.push(`Ignored selection "${key}": that choice does not apply (closed gate).`);
      changed = true;
    }
    if (!changed) return ctx;
    ctx = buildContext(values, selections);
  }
}
