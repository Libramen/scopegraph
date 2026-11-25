/**
 * Condition value checks: once a condition name resolves, cross-check its
 * values against what the referent accepts — select/multiselect option
 * membership, weekday/season names for derived values, and orderability for
 * gt/gte/lt/lte operators.
 */
import { NUMERIC_DERIVED, WEEKDAYS, isScalar } from './context.js';
import type { ResolvedName, ScopeCtx } from './context.js';
import { didYouMeanSuffix } from './diagnostics.js';

/** Value cross-checks: option membership, weekday names, season names. */
export function checkValues(
  resolved: ResolvedName,
  op: 'eq' | 'neq' | 'in' | 'not_in' | 'contains',
  value: unknown,
  path: (string | number)[],
  ctx: ScopeCtx,
): void {
  if (resolved.kind !== 'parameter') {
    const derived = resolved.kind === 'derived' ? resolved.derived : undefined;
    if (derived === 'weekday') {
      const strings = Array.isArray(value) ? value.filter(isScalar) : [value];
      for (const item of strings) {
        if (typeof item === 'string' && !(WEEKDAYS as readonly string[]).includes(item)) {
          ctx.rep.error(
            'INVALID_CONDITION',
            `weekday value '${item}' is not a day name`,
            path,
            `valid values: ${WEEKDAYS.join(', ')}`,
          );
        }
      }
    }
    if (
      derived === 'season' &&
      typeof value === 'string' &&
      value !== 'none' &&
      !ctx.seasons.has(value)
    ) {
      ctx.rep.warn(
        'INVALID_CONDITION',
        `season '${value}' is not declared in business.yaml; this comparison can never be true`,
        path,
        `declared seasons: ${[...ctx.seasons].join(', ') || '(none)'} (or 'none' for dates outside every season)${didYouMeanSuffix(value, [...ctx.seasons])}`,
      );
    }
    return;
  }

  const param = resolved.param;
  if (param.type !== 'select' && param.type !== 'multiselect') return;
  const optionValues = (param.options ?? []).map((o) => o.value);
  const strings = Array.isArray(value) ? value.filter(isScalar) : [value];
  for (const item of strings) {
    if (typeof item === 'string' && !optionValues.includes(item)) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `${param.type} parameter '${param.name}' compared with '${item}' (${op}), which is not one of its options`,
        path,
        `options of '${param.name}': ${optionValues.join(', ')}`,
      );
    }
  }
}

/** gt/gte/lt/lte against a non-numeric referent can never be intended. */
export function checkNumericRef(
  resolved: ResolvedName,
  op: string,
  name: string,
  path: (string | number)[],
  ctx: ScopeCtx,
): void {
  const ORDERABLE: readonly string[] = ['number', 'integer', 'date', 'time'];
  if (resolved.kind === 'parameter') {
    if (!ORDERABLE.includes(resolved.param.type)) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `'${op}' orders the ${resolved.param.type} parameter '${name}'; ordering needs a number, integer, date or time parameter`,
        path,
        'for select values use eq/in; for free text use matches',
      );
    }
    return;
  }
  const fact = resolved.kind === 'fact' ? resolved.fact : undefined;
  if (fact && fact.type !== 'number') {
    ctx.rep.error(
      'INVALID_CONDITION',
      `'${op}' orders the ${fact.type} fact '${name}'; only number facts support ordering`,
      path,
    );
    return;
  }
  const derived = resolved.kind === 'derived' ? resolved.derived : undefined;
  if (derived && !NUMERIC_DERIVED.includes(derived)) {
    ctx.rep.error(
      'INVALID_CONDITION',
      `'${op}' orders the derived value '${derived}' (${derived === 'weekday' || derived === 'season' ? 'text' : 'boolean'})`,
      path,
      `numeric derived values are: ${NUMERIC_DERIVED.join(', ')}`,
    );
  }
}
