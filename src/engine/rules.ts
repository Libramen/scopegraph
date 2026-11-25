/**
 * Rule evaluation and violation helpers: evaluating one rule against a
 * context (only a TRUE `when` applies an effect; UNKNOWN asks instead),
 * target lookup/labels, and deduped block reasons.
 */
import { evaluateCondition, unknownRefs } from '../conditions/index.js';
import type { OfferingScope, Option, OptionGroup, Rule, SelectionTarget, Truth } from '../graph/types.js';
import type { Blocked, ConditionContext, RuleTraceEntry } from './types.js';

// ─── Rule evaluation ─────────────────────────────────────────────────────────

export interface EvaluatedRule {
  rule: Rule;
  when: Truth;
  entry: RuleTraceEntry;
}

function isTargetSelected(target: SelectionTarget, ctx: ConditionContext): boolean {
  if (target.type === 'option') return ctx.chosenOptions.has(target.id);
  return (ctx.selectedByGroup.get(target.id)?.size ?? 0) > 0;
}

export function evaluateRule(rule: Rule, ctx: ConditionContext): EvaluatedRule {
  const when: Truth = rule.when ? evaluateCondition(rule.when, ctx) : 'TRUE';
  let fired = false;
  // Only a definite TRUE applies an effect; an UNKNOWN `when` leads to a question instead.
  if (when === 'TRUE') {
    const effect = rule.effect;
    if (effect.kind === 'block' || effect.kind === 'ask') fired = true;
    else if (effect.kind === 'require') fired = !isTargetSelected(effect.target, ctx);
    else fired = isTargetSelected(effect.target, ctx);
  }
  return {
    rule,
    when,
    entry: {
      id: rule.id,
      offering: rule.ownerOfferingId,
      effect: rule.effect.kind,
      when,
      fired,
      unknownRefs: rule.when ? unknownRefs(rule.when, ctx) : [],
    },
  };
}

export function findOption(scope: OfferingScope, optionId: string): { group: OptionGroup; option: Option } | undefined {
  for (const group of scope.optionGroups) {
    const option = group.options.find((o) => o.id === optionId);
    if (option) return { group, option };
  }
  return undefined;
}

function targetLabel(target: SelectionTarget, scope: OfferingScope): string {
  if (target.type === 'option') return findOption(scope, target.id)?.option.label ?? target.id;
  return scope.optionGroups.find((g) => g.key === target.id)?.label ?? target.id;
}

export function violationMessage(rule: Rule, scope: OfferingScope): string {
  const effect = rule.effect;
  if (effect.kind === 'require') return effect.message ?? `Requires ${targetLabel(effect.target, scope)}`;
  if (effect.kind === 'exclude') return effect.message ?? `Not available with ${targetLabel(effect.target, scope)}`;
  return effect.kind === 'block' ? effect.message : '';
}

/**
 * One reason per distinct message: a package inherits the same policy rule
 * from several contained products, and the buyer should read it once. The
 * first rule (priority order) supplies `ruleId`; the trace keeps every rule.
 */
export function ruleReasons(rules: Rule[], scope: OfferingScope): Blocked['reasons'] {
  const seen = new Set<string>();
  const reasons: Blocked['reasons'] = [];
  for (const rule of rules) {
    const message = violationMessage(rule, scope);
    if (seen.has(message)) continue;
    seen.add(message);
    reasons.push({ code: 'RULE', message, ruleId: rule.id });
  }
  return reasons;
}
