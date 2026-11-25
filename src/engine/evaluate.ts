/**
 * `evaluate` — one scoping request in, one of five outcomes out.
 *
 * The pipeline runs top to bottom in `evaluate` below, from lookup to
 * pricing. Pure and synchronous.
 *
 * Its pieces are in `inputs.ts` (validation), `gates.ts` (`ask` rules and
 * dropping answers to closed steps), `rules.ts` (rule evaluation) and
 * `questions.ts` (next-question planning and question builders).
 */
import type { Graph, OfferingScope, Value } from '../graph/types.js';
import { choicePriceHint, formatMoney, priceOffering } from '../pricing/index.js';
import { analyzeDate, type DateAnalysis } from './derived.js';
import { dropClosedGateInputs, gateState, pricingInputs } from './gates.js';
import { isUnset, validateAnswers, validateSelections, type InputError } from './inputs.js';
import { dateQuestion, nextQuestions } from './questions.js';
import { evaluateRule, ruleReasons } from './rules.js';
import type { AddOnGroup, Blocked, EvaluateOptions, ScopeRequest, ScopeResult, Trace } from './types.js';

export { choiceQuestion, parameterQuestion } from './questions.js';

export function evaluate(graph: Graph, request: ScopeRequest, options: EvaluateOptions = {}): ScopeResult {
  const now = options.now ?? new Date();
  const trace: Trace = { values: {}, pendingQuestions: [], rules: [], pricing: [], warnings: [] };
  const withTrace = <T extends ScopeResult>(result: T): T =>
    options.trace === false ? result : { ...result, trace };
  const offeringId = request.offering;

  // Lookup. Buyers cannot tell an unknown id from an unlisted one (paused,
  // archived, package-only): every unlisted offering is NOT_FOUND to them.
  const audience = options.audience ?? 'owner';
  const buyer = audience === 'buyer';
  const offering = Object.hasOwn(graph.offerings, offeringId) ? graph.offerings[offeringId] : undefined;
  if (!offering || (buyer && (offering.status !== 'active' || !offering.bookable))) {
    return withTrace({ status: 'unavailable', offering: offeringId, code: 'NOT_FOUND', message: `No offering "${offeringId}".` });
  }
  if (offering.status !== 'active') {
    return withTrace({
      status: 'unavailable',
      offering: offeringId,
      code: 'NOT_ACTIVE',
      message: `${offering.name} is not on sale right now.`,
    });
  }
  if (!offering.bookable) {
    return withTrace({
      status: 'unavailable',
      offering: offeringId,
      code: 'NOT_BOOKABLE',
      message: `${offering.name} is sold only inside a package.`,
    });
  }
  const scope = offering.scope;
  if (scope.inactiveContents.length > 0) {
    return withTrace({
      status: 'unavailable',
      offering: offeringId,
      code: 'CONTENTS_UNAVAILABLE',
      // The inactive ids may name unreleased products: owners only.
      message: buyer
        ? `${offering.name} is not available right now.`
        : `${offering.name} includes items that are not on sale right now: ${scope.inactiveContents.join(', ')}.`,
    });
  }

  // Input validation (collect every error).
  // Owners get every answer/selection error now. Buyers (`disclosure:
  // progressive`) get none here: an invalid value is dropped like an unknown
  // name, and its error is only returned if that step turns out to be the next
  // question — so probing with junk values reveals nothing that the next
  // question would not. Before pricing, though, an invalid value for any step
  // that is still open is reported (see below). Date format errors are not
  // catalog data: always now.
  const errors: InputError[] = [];
  const valueErrors: InputError[] = [];
  const answers = validateAnswers(scope, request.answers ?? {}, audience, valueErrors, trace.warnings);
  const selections = validateSelections(scope, request.selections ?? {}, audience, valueErrors, trace.warnings);
  const deferredErrors = buyer ? valueErrors : [];
  if (buyer) {
    for (const error of valueErrors) trace.warnings.push(`Ignored invalid ${error.field}: ${error.message}`);
  } else {
    errors.push(...valueErrors);
  }
  let date: DateAnalysis | undefined;
  const requestDate: unknown = request.date;
  if (!isUnset(requestDate)) {
    if (offering.date === 'none') {
      errors.push({ field: 'date', code: 'UNKNOWN_FIELD', message: `${offering.name} does not take a date.` });
    } else if (typeof requestDate !== 'string' || !(date = analyzeDate(requestDate, now, graph.business))) {
      errors.push({
        field: 'date',
        code: 'INVALID_DATE',
        message: 'Use an ISO 8601 date (2026-07-04) or date-time (2026-07-04T09:00:00-07:00).',
      });
    }
  }
  if (errors.length > 0) return withTrace({ status: 'invalid', offering: offeringId, errors });

  // Values: defaults ← answers ← declared facts ← derived.
  // Null prototype: parameter names such as `constructor` must not read Object.prototype.
  const values: Record<string, Value> = Object.create(null);
  for (const p of scope.parameters) if (p.default !== undefined) values[p.name] = p.default;
  Object.assign(values, answers);
  // Facts are trusted: a declared fact name never takes a buyer answer or default.
  for (const name of Object.keys(graph.business.facts)) {
    delete values[name];
    delete answers[name];
  }
  for (const [name, value] of Object.entries(request.facts ?? {})) {
    if (!Object.hasOwn(graph.business.facts, name)) {
      trace.warnings.push(`Ignored undeclared fact "${name}".`);
      continue;
    }
    if (!isUnset(value)) values[name] = value;
  }
  if (date) Object.assign(values, date.values);
  trace.values = values;

  // Answers / selections for steps an `ask` rule keeps closed are dropped before rules and pricing.
  const ctx = dropClosedGateInputs(scope, values, answers, selections, trace.warnings);

  // Required facts fail closed.
  const missingFacts = Object.values(graph.business.facts).filter((f) => f.required && isUnset(values[f.name]));
  if (missingFacts.length > 0) {
    for (const f of missingFacts) {
      trace.warnings.push(`Required fact "${f.name}" was not supplied (server facts hook / scenario facts).`);
    }
    // One generic reason: fact names are server-side vocabulary, never shown to buyers.
    return withTrace({
      status: 'blocked',
      offering: offeringId,
      reasons: [{ code: 'FACTS_UNAVAILABLE', message: 'Some information needed to quote this is unavailable right now; please try again later.' }],
    });
  }

  // Rules: priority ascending, then declaration order; active only.
  const rules = scope.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.active)
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index)
    .map(({ rule }) => evaluateRule(rule, ctx));
  trace.rules = rules.map((r) => r.entry);

  // Block rules: a fired block refuses the request before anything is asked.
  const blocks = rules.filter((r) => r.rule.effect.kind === 'block' && r.entry.fired);
  if (blocks.length > 0) {
    return withTrace({
      status: 'blocked',
      offering: offeringId,
      reasons: ruleReasons(blocks.map(({ rule }) => rule), scope),
    });
  }

  // Date.
  if (offering.date === 'required' && !date) {
    const question = dateQuestion(offering);
    trace.questionReason = 'date';
    return withTrace({ status: 'needs_input', offering: offeringId, question, reason: 'date' });
  }
  if (date) {
    if (date.inPast) {
      return withTrace({
        status: 'blocked',
        offering: offeringId,
        reasons: [{ code: 'DATE_IN_PAST', message: 'That date is in the past.' }],
      });
    }
    const leadHours = date.values.leadTimeHours as number;
    if (offering.minNoticeHours !== undefined && leadHours < offering.minNoticeHours) {
      return withTrace({
        status: 'blocked',
        offering: offeringId,
        reasons: [
          {
            code: 'DATE_TOO_SOON',
            message: `${offering.name} needs at least ${offering.minNoticeHours} hours' notice.`,
          },
        ],
      });
    }
  }

  // Next question.
  const candidates = nextQuestions(graph, offering, ctx, rules, selections, date !== undefined);
  const first = candidates[0];
  if (first) {
    // A buyer's dropped invalid value surfaces only for the step asked next.
    const askedField = first.question.kind === 'choice' ? `selections.${first.question.key}` : `answers.${first.question.key}`;
    const asked = deferredErrors.filter((error) => error.field === askedField);
    if (asked.length > 0) return withTrace({ status: 'invalid', offering: offeringId, errors: asked });
    trace.questionReason = first.reason;
    trace.pendingQuestions = [...new Set(candidates.slice(1).map((c) => c.question.key))].filter(
      (key) => key !== first.question.key,
    );
    return withTrace({ status: 'needs_input', offering: offeringId, question: first.question, reason: first.reason });
  }

  // A buyer's invalid value for a step that is still open was replaced by its
  // default (or, for options, dropped): quoting now would price a request the
  // buyer did not send. Steps that are closed (or unknown, or facts) stay
  // silent, exactly as when they are never asked.
  if (deferredErrors.length > 0) {
    const gates = gateState(rules);
    const priceInputs = new Set(pricingInputs(scope, ctx));
    const open = deferredErrors.filter(({ field }) => {
      if (field.startsWith('selections.')) return gates.get(`group:${field.slice('selections.'.length)}`) ?? true;
      const name = field.slice('answers.'.length);
      if (Object.hasOwn(graph.business.facts, name)) return false;
      return (gates.get(`parameter:${name}`) ?? true) || priceInputs.has(name);
    });
    if (open.length > 0) return withTrace({ status: 'invalid', offering: offeringId, errors: open });
  }

  // Remaining require / exclude violations.
  const violations = rules.filter((r) => r.entry.fired && (r.rule.effect.kind === 'require' || r.rule.effect.kind === 'exclude'));
  if (violations.length > 0) {
    return withTrace({
      status: 'blocked',
      offering: offeringId,
      reasons: ruleReasons(violations.map(({ rule }) => rule), scope),
    });
  }

  // Pricing.
  const priced = priceOffering(graph, offering.id, { context: ctx });
  trace.pricing = priced.trace;
  const currency = graph.business.currency;
  if (!priced.ok) {
    trace.warnings.push(`${priced.code}: ${priced.message}`);
    return withTrace({
      status: 'blocked',
      offering: offeringId,
      reasons: [
        {
          code: 'PRICING_ERROR',
          message: "We can't price this request automatically right now. Please contact us for a quote.",
        },
      ],
    });
  }
  const minimum = priced.minimumSpend;
  if (minimum && minimum.mode === 'decline' && minimum.shortfallCents > 0) {
    const reason: Blocked['reasons'][number] = {
      code: 'MINIMUM_SPEND',
      message: `${offering.name} has a minimum spend of ${formatMoney(minimum.minimumCents, currency)}; this request is ${formatMoney(minimum.shortfallCents, currency)} short.`,
    };
    return withTrace({ status: 'blocked', offering: offeringId, reasons: [reason] });
  }

  // Qualified. The full request has every answer incl. defaults; a buyer's
  // summary echoes only the answers they supplied that still apply (`answers`
  // after the closed-gate drop), so defaults never name unasked questions.
  const normalizedAnswers = (source: Record<string, Value>): Record<string, Value> => {
    const out: Record<string, Value> = {};
    for (const p of scope.parameters) {
      const v = Object.hasOwn(source, p.name) ? source[p.name] : undefined;
      if (!p.internal && v !== undefined && !Object.hasOwn(graph.business.facts, p.name)) out[p.name] = v;
    }
    return out;
  };
  const summarySelections: Record<string, string[]> = {};
  for (const [key, ids] of selections) summarySelections[key] = ids.map((id) => id.slice(key.length + 1));
  const full = { answers: normalizedAnswers(values), selections: summarySelections, ...(date ? { date: request.date } : {}) };
  const addOns = availableAddOns(scope, gateState(rules), selections, currency);
  // A buyer's summary leaves out groups answered with "none": echoing them
  // would confirm group names the buyer was never asked about.
  const buyerSelections = Object.fromEntries(Object.entries(summarySelections).filter(([, keys]) => keys.length > 0));
  return withTrace({
    status: 'qualified',
    offering: offeringId,
    quote: priced.quote,
    ...(buyer
      ? { summary: { ...full, answers: normalizedAnswers(answers), selections: buyerSelections }, request: full }
      : { summary: full }),
    ...(addOns.length > 0 ? { addOns } : {}),
  });
}

/**
 * Optional option groups the buyer could still add: not required, not behind a
 * closed `ask` gate, with room for another pick; options already chosen are
 * left out. Only labels and unconditional price hints — never rules or conditions.
 */
function availableAddOns(
  scope: OfferingScope,
  gates: Map<string, boolean>,
  selections: Map<string, string[]>,
  currency: string,
): AddOnGroup[] {
  const addOns: AddOnGroup[] = [];
  for (const group of scope.optionGroups) {
    if (group.required || group.minSelections > 0 || gates.get(`group:${group.key}`) === false) continue;
    const chosen = new Set(selections.get(group.key) ?? []);
    const full = group.mode === 'single' ? chosen.size > 0 : group.maxSelections !== undefined && chosen.size >= group.maxSelections;
    if (full) continue;
    const options = group.options
      .filter((option) => !chosen.has(option.id))
      .map((option) => {
        const priceHint = choicePriceHint(option, currency);
        return { key: option.key, label: option.label, ...(priceHint !== undefined ? { priceHint } : {}) };
      });
    if (options.length > 0) addOns.push({ key: group.key, label: group.label, mode: group.mode, options });
  }
  return addOns;
}
