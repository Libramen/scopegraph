/**
 * Input validation for `evaluate`: answers, selections and per-parameter
 * value checks (incl. the RE2 test for a parameter's `pattern`). Under the
 * `buyer` audience unknown names are ignored
 * with a trace warning, and the engine returns a value error only for the
 * step it asks next (whose question already shows the type, bounds and
 * options), so buyer messages may carry the same detail as owner ones.
 */
import { patternTest } from '../conditions/index.js';
import type { OfferingScope, Parameter, Value } from '../graph/types.js';
import type { Audience, InvalidInput } from './types.js';

export type InputError = InvalidInput['errors'][number];

/** Undefined, null and '' count as "not answered". */
export function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

// ─── Input validation ────────────────────────────────────────────────────────

/** Longest string answer accepted (so a `matches` leaf never sees more). */
const MAX_STRING_ANSWER = 512;

/** C0/C1 control characters except tab and newline: never valid in a text answer. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * Unknown (and internal) names are `UNKNOWN_FIELD` for owners; for buyers they
 * are ignored with a warning, like answers to questions that do not apply yet.
 * Messages read `<label> <problem>` for owners and
 * `Invalid answer for "<label>": <problem>.` for buyers.
 */
export function validateAnswers(
  scope: OfferingScope,
  answers: Record<string, unknown>,
  audience: Audience,
  errors: InputError[],
  warnings: string[],
): Record<string, Value> {
  const accepted: Record<string, Value> = {};
  for (const [key, value] of Object.entries(answers)) {
    const param = scope.parameters.find((p) => p.name === key && !p.internal);
    if (!param) {
      if (audience === 'buyer') warnings.push(`Ignored answer "${key}": not a question for this offering.`);
      else errors.push({ field: `answers.${key}`, code: 'UNKNOWN_FIELD', message: `"${key}" is not a question for this offering.` });
      continue;
    }
    if (isUnset(value)) continue;
    const label = param.label || param.name;
    const tooLong = (x: unknown): boolean => typeof x === 'string' && x.length > MAX_STRING_ANSWER;
    const problems = tooLong(value) || (Array.isArray(value) && value.some(tooLong))
      ? [`must be at most ${MAX_STRING_ANSWER} characters`]
      : parameterValueProblems(param, value);
    if (problems.length === 0) accepted[key] = value as Value;
    for (const problem of problems) {
      const message = audience === 'buyer' ? `Invalid answer for "${label}": ${problem}.` : `${label} ${problem}`;
      errors.push({ field: `answers.${key}`, code: 'INVALID_VALUE', message });
    }
  }
  return accepted;
}

/** What is wrong with one present parameter value, as predicates ("must be at least 1"); empty when valid. */
function parameterValueProblems(param: Parameter, value: unknown): string[] {
  switch (param.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ['must be a number'];
      if (param.type === 'integer' && !Number.isInteger(value)) return ['must be a whole number'];
      const out: string[] = [];
      if (param.min !== undefined && value < param.min) out.push(`must be at least ${param.min}`);
      if (param.max !== undefined && value > param.max) out.push(`must be at most ${param.max}`);
      return out;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : ['must be true or false'];
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? [] : ['must be a calendar date (YYYY-MM-DD)'];
    case 'time':
      return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
        ? []
        : ['must be a time of day (HH:MM or HH:MM:SS, 24-hour)'];
    case 'datetime': {
      const m =
        typeof value === 'string'
          ? /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
          : null;
      return m && isCalendarDate(`${m[1]}-${m[2]}-${m[3]}`) && Number.isFinite(Date.parse(value as string))
        ? []
        : ['must be a date-time with a UTC offset (RFC 3339)'];
    }
    case 'string': {
      if (typeof value !== 'string') return ['must be a string'];
      const out: string[] = [];
      if (CONTROL_CHARS.test(value)) out.push('must not contain control characters (only tab and newline)');
      if (param.min !== undefined && value.length < param.min) out.push(`must be at least ${param.min} characters`);
      if (param.max !== undefined && value.length > param.max) out.push(`must be at most ${param.max} characters`);
      if (param.pattern !== undefined && !patternTest(param.pattern, value)) out.push('does not match the required pattern');
      return out;
    }
    case 'select': {
      const allowed = param.options?.map((o) => o.value);
      if (!allowed?.length || (typeof value === 'string' && allowed.includes(value))) return [];
      return [`must be one of these values: ${allowed.join(', ')}`];
    }
    case 'multiselect': {
      const allowed = param.options?.map((o) => o.value);
      if (!allowed?.length) return [];
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && allowed.includes(v))) {
        return [`may only contain: ${allowed.join(', ')}`];
      }
      // Distinct entries, so never more than there are options.
      return new Set(value).size === value.length ? [] : ['must not list an option twice'];
    }
  }
}

function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Returns group key → selected option ids (`<group>.<option>`), scope group
 * order. An explicit empty list is kept: the group was answered with "none".
 * Unknown group keys: `UNKNOWN_FIELD` for owners, ignored with a warning for buyers.
 * An owner's group with any error is rejected whole. A buyer's unknown options
 * are dropped and the valid ones kept (all-unknown = as if not sent); the
 * errors are still collected, for the engine to return if the group is asked next.
 */
export function validateSelections(
  scope: OfferingScope,
  selections: Record<string, unknown>,
  audience: Audience,
  errors: InputError[],
  warnings: string[],
): Map<string, string[]> {
  const buyer = audience === 'buyer';
  const byKey = new Map<string, string[]>();
  for (const [key, raw] of Object.entries(selections)) {
    const field = `selections.${key}`;
    const group = scope.optionGroups.find((g) => g.key === key);
    if (!group) {
      if (buyer) warnings.push(`Ignored selection "${key}": not a choice for this offering.`);
      else errors.push({ field, code: 'UNKNOWN_FIELD', message: `"${key}" is not a choice for this offering.` });
      continue;
    }
    const label = group.label;
    const optionKeys = group.options.map((o) => o.key).join(', ');
    const list = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
      errors.push({
        field,
        code: 'INVALID_VALUE',
        message: buyer
          ? `Invalid choice for "${label}": select by option key (a string or a list of strings).`
          : `Select ${label} by option key (a string or a list of strings).`,
      });
      continue;
    }
    const ids: string[] = [];
    let unknown = 0;
    for (const optionKey of new Set(list as string[])) {
      const option = group.options.find((o) => o.key === optionKey);
      if (option) {
        ids.push(option.id);
        continue;
      }
      unknown += 1;
      errors.push({
        field,
        code: 'UNKNOWN_OPTION',
        message: buyer
          ? `Invalid choice for "${label}": "${optionKey}" is not one of its options (${optionKeys}).`
          : `"${optionKey}" is not an option of ${label}. Options: ${optionKeys}.`,
      });
    }
    const max = group.mode === 'single' ? 1 : group.maxSelections;
    if (max !== undefined && ids.length > max) {
      errors.push({
        field,
        code: 'TOO_MANY_SELECTIONS',
        message: buyer
          ? `Too many options selected for "${label}": pick ${max === 1 ? 'one' : `at most ${max}`}.`
          : group.mode === 'single'
            ? `${label} takes a single choice.`
            : `${label} takes at most ${max} choice${max === 1 ? '' : 's'}.`,
      });
      continue;
    }
    if (unknown === 0 || (buyer && ids.length > 0)) byKey.set(key, ids);
  }
  // Scope group order, option order within a group (deterministic summaries / pricing).
  const ordered = new Map<string, string[]>();
  for (const group of scope.optionGroups) {
    const ids = byKey.get(group.key);
    if (ids) ordered.set(group.key, group.options.filter((o) => ids.includes(o.id)).map((o) => o.id));
  }
  return ordered;
}
