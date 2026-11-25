/**
 * Next-question planning for `evaluate`: every pending question in ask order,
 * and the question builders.
 */
import { evaluateCondition, unknownRefs } from '../conditions/index.js';
import type { Condition, Graph, Offering, Option, OptionGroup, Parameter } from '../graph/types.js';
import { choicePriceHint } from '../pricing/index.js';
import { DATE_DERIVED_NAMES } from './derived.js';
import { gateState, pricingInputs, selectedOptionAdjustments } from './gates.js';
import { isUnset } from './inputs.js';
import { findOption, violationMessage, type EvaluatedRule } from './rules.js';
import type {
  ChoiceQuestion,
  ConditionContext,
  DateQuestion,
  ParameterQuestion,
  Question,
  QuestionReason,
} from './types.js';

// ─── Next question ───────────────────────────────────────────────────────────

interface Candidate {
  question: Question;
  reason: QuestionReason;
}

/**
 * Every pending question in ask order (first = the one to ask). Each kind of
 * question is collected in turn, with its guards:
 *
 * 1. Required parameters that are unanswered.
 * 2. Rule inputs: answers an undecided rule `when` needs.
 * 3. Pricing facts: `role: fact` answers an undecided adjustment `when` needs.
 * 4. Price inputs: quantities and formula inputs of applicable price lines.
 * 5. Required choices: required option groups below their minimum.
 * 6. Rule requirements: groups a fired `require` rule needs a selection from.
 */
export function nextQuestions(
  graph: Graph,
  offering: Offering,
  ctx: ConditionContext,
  rules: EvaluatedRule[],
  selections: Map<string, string[]>,
  hasDate: boolean,
): Candidate[] {
  const scope = offering.scope;
  const currency = graph.business.currency;
  const out: Candidate[] = [];

  const gates = gateState(rules);
  const isOpen = (type: 'parameter' | 'group', id: string): boolean => gates.get(`${type}:${id}`) ?? true;
  const askable = (p: Parameter | undefined): p is Parameter =>
    p !== undefined && !p.internal && isOpen('parameter', p.name) && isUnset(ctx.values[p.name]);
  const parameters = new Map(scope.parameters.map((p) => [p.name, p]));
  const dateAskable = offering.date !== 'none' && !hasDate;

  // Required parameters, scope order.
  for (const p of scope.parameters) {
    if (p.required && askable(p)) out.push({ question: parameterQuestion(p), reason: 'required' });
  }

  // Rule inputs: what an UNKNOWN rule `when` needs (only names that can still change it).
  for (const { rule, when } of rules) {
    if (when !== 'UNKNOWN' || !rule.when) continue;
    for (const name of unknownRefs(rule.when, ctx)) {
      if (DATE_DERIVED_NAMES.includes(name)) {
        if (dateAskable) out.push({ question: dateQuestion(offering), reason: 'rule_dependency' });
        continue;
      }
      if (!isParameterLeaf(rule.when, name)) continue;
      const p = parameters.get(name);
      if (askable(p)) out.push({ question: parameterQuestion(p), reason: 'rule_dependency' });
    }
  }

  // Pricing facts: `role: fact` parameters (or the date, for date-derived
  // names) an UNKNOWN adjustment `when` needs.
  for (const adjustment of [...scope.adjustments, ...selectedOptionAdjustments(scope, ctx)]) {
    if (!adjustment.when || evaluateCondition(adjustment.when, ctx) !== 'UNKNOWN') continue;
    for (const name of unknownRefs(adjustment.when, ctx)) {
      if (DATE_DERIVED_NAMES.includes(name)) {
        if (dateAskable) out.push({ question: dateQuestion(offering), reason: 'pricing_fact' });
        continue;
      }
      if (!isParameterLeaf(adjustment.when, name)) continue;
      const p = parameters.get(name);
      if (p?.role === 'fact' && askable(p)) out.push({ question: parameterQuestion(p), reason: 'pricing_fact' });
    }
  }

  // Price inputs: missing quantity / formula inputs of applicable price lines —
  // asked even when an `ask` rule keeps their step closed (otherwise pricing
  // fails closed with no way forward).
  for (const name of pricingInputs(scope, ctx)) {
    const p = parameters.get(name);
    if (p && !p.internal && isUnset(ctx.values[name])) out.push({ question: parameterQuestion(p), reason: 'pricing_input' });
  }

  // Required choices: required, open groups below their minimum.
  for (const group of scope.optionGroups) {
    if (!isOpen('group', group.key)) continue;
    const required = group.required || group.minSelections > 0;
    if (!required) continue;
    const count = selections.get(group.key)?.length ?? 0;
    if (count < Math.max(group.minSelections, 1)) {
      out.push({ question: choiceQuestion(group, currency), reason: 'required_choice' });
    }
  }

  // Rule requirements: a fired `require` with an unselected target asks its
  // group ONCE (a group that was answered, even with an explicit empty list,
  // is never asked again; the request is then blocked).
  for (const { rule, entry } of rules) {
    const effect = rule.effect;
    if (effect.kind !== 'require' || !entry.fired) continue;
    let group: OptionGroup | undefined;
    let requiredOption: Option | undefined;
    if (effect.target.type === 'group') {
      group = scope.optionGroups.find((g) => g.key === effect.target.id);
    } else {
      const found = findOption(scope, effect.target.id);
      group = found?.group;
      requiredOption = found?.option;
    }
    if (!group || selections.has(group.key)) continue;
    const question = choiceQuestion(group, currency);
    if (requiredOption) question.requiredOption = requiredOption.key;
    question.message = violationMessage(rule, scope);
    out.push({ question, reason: 'rule_requirement' });
  }

  return out;
}

/**
 * Askable leaves are `parameter` (or untyped) leaves that compare a value.
 * Facts, derived values, options and presence tests (`exists`, `selected`)
 * are never asked.
 */
function isParameterLeaf(condition: Condition, name: string): boolean {
  if (condition.conditions && condition.conditions.length > 0) {
    return condition.conditions.some((c) => isParameterLeaf(c, name));
  }
  if (condition.name !== name) return false;
  if (condition.ref !== undefined && condition.ref !== 'parameter') return false;
  return condition.op !== 'exists' && condition.op !== 'selected';
}

export function parameterQuestion(p: Parameter): ParameterQuestion {
  return {
    kind: 'parameter',
    key: p.name,
    label: p.label,
    ...(p.description !== undefined ? { description: p.description } : {}),
    type: p.type,
    required: p.required,
    ...(p.options !== undefined ? { options: p.options.map((o) => ({ ...o })) } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.pattern !== undefined ? { pattern: p.pattern } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  };
}

export function choiceQuestion(group: OptionGroup, currency: string): ChoiceQuestion {
  const required = group.required || group.minSelections > 0;
  return {
    kind: 'choice',
    key: group.key,
    label: group.label,
    ...(group.description !== undefined ? { description: group.description } : {}),
    mode: group.mode,
    minSelections: Math.max(group.minSelections, required ? 1 : 0),
    ...(group.maxSelections !== undefined ? { maxSelections: group.maxSelections } : {}),
    options: group.options.map((o) => {
      const priceHint = choicePriceHint(o, currency);
      return {
        key: o.key,
        label: o.label,
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(priceHint !== undefined ? { priceHint } : {}),
      };
    }),
  };
}

export function dateQuestion(offering: Offering): DateQuestion {
  return {
    kind: 'date',
    key: 'date',
    label: 'Date',
    required: offering.date === 'required',
    ...(offering.minNoticeHours !== undefined ? { minNoticeHours: offering.minNoticeHours } : {}),
  };
}
