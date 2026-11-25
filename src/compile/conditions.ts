/**
 * Condition compilation: the `when:` grammar — shorthand scalars and lists,
 * all/any/not compounds, `selected:` option references and the operator
 * object form — resolved against the offering's parameters, facts and
 * derived values, and turned into canonical `Condition` trees.
 */
import { KEY_PATTERN } from '../catalog/schema.js';
import type { Condition } from '../graph/types.js';
import { PATTERN_HINT, patternError } from '../conditions/index.js';
import { DERIVED_NAMES, RESERVED, isCalendarDate, isDefined, isScalar } from './context.js';
import type { ResolvedName, ScopeCtx } from './context.js';
import { didYouMeanSuffix } from './diagnostics.js';
import { checkNumericRef, checkValues } from './values.js';

const CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'contains',
  'matches',
  'exists',
] as const;

export function compileCondition(
  raw: unknown,
  path: (string | number)[],
  ctx: ScopeCtx,
): Condition | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    ctx.rep.error(
      'INVALID_CONDITION',
      'a condition must be a mapping of names to values',
      path,
      "e.g. { participants: { gte: 4 } } or { selected: extras.photos }",
    );
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    ctx.rep.error(
      'INVALID_CONDITION',
      'a condition needs at least one key',
      path,
      'drop empty `when` mappings; omit `when` entirely for "always"',
    );
    return undefined;
  }

  const parts: Condition[] = [];
  for (const [key, value] of entries) {
    const keyPath = [...path, key];
    if (key === 'all' || key === 'any') {
      if (!Array.isArray(value) || value.length === 0) {
        ctx.rep.error(
          'INVALID_CONDITION',
          `'${key}' must be a list with at least one condition`,
          keyPath,
          "e.g. { any: [{ weekday: sat }, { weekday: sun }] }",
        );
        continue;
      }
      const children = value
        .map((child, index) => compileCondition(child, [...keyPath, index], ctx))
        .filter(isDefined);
      parts.push({
        op: key,
        conditions: children,
      });
    } else if (key === 'not') {
      const child =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? compileCondition(value, keyPath, ctx)
          : undefined;
      if (child === undefined && value !== null && typeof value !== 'object') {
        ctx.rep.error(
          'INVALID_CONDITION',
          "'not' takes a single condition mapping",
          keyPath,
          'e.g. { not: { weekday: sat } }',
        );
        continue;
      }
      parts.push({
        op: 'not',
        conditions: child !== undefined ? [child] : [],
      });
    } else if (key === 'selected') {
      const leaf = compileSelected(value, keyPath, ctx);
      if (leaf) parts.push(leaf);
    } else {
      const leaf = compileNameCondition(key, value, keyPath, ctx);
      if (leaf) parts.push(leaf);
    }
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { op: 'all', conditions: parts };
}

function compileSelected(
  value: unknown,
  path: (string | number)[],
  ctx: ScopeCtx,
): Condition | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    ctx.rep.error(
      'INVALID_CONDITION',
      "'selected' takes an option id like 'extras.photos' or a group key like 'extras'",
      path,
    );
    return undefined;
  }
  const segments = value.split('.');
  const invalid =
    segments.length > 2 || segments.some((segment) => !KEY_PATTERN.test(segment));
  if (invalid) {
    ctx.rep.error(
      'INVALID_CONDITION',
      `'selected: ${value}' is not '<group>' or '<group>.<option>'`,
      path,
    );
    return undefined;
  }
  const groupKey = segments[0]!;
  const group = ctx.ownGroups.get(groupKey);
  if (!group) {
    ctx.rep.error(
      'UNKNOWN_REFERENCE',
      `'selected' names unknown option group '${groupKey}'`,
      path,
      `known groups: ${[...ctx.ownGroups.keys()].join(', ') || '(none)'}${didYouMeanSuffix(groupKey, [...ctx.ownGroups.keys()])}`,
    );
    return undefined;
  }
  if (segments.length === 2) {
    const optionKey = segments[1]!;
    if (!group.options.some((option) => option.key === optionKey)) {
      ctx.rep.error(
        'UNKNOWN_REFERENCE',
        `'selected' names unknown option '${value}'`,
        path,
        `options of '${groupKey}': ${group.options.map((o) => o.key).join(', ')}${didYouMeanSuffix(optionKey, group.options.map((o) => o.key))}`,
      );
      return undefined;
    }
  }
  return { ref: 'option', name: value, op: 'selected' };
}

function resolveName(
  name: string,
  path: (string | number)[],
  ctx: ScopeCtx,
): ResolvedName | undefined {
  const param = ctx.params.get(name);
  if (param) return { kind: 'parameter', param };
  const fact = ctx.facts.get(name);
  if (fact) return { kind: 'fact', fact };
  if ((DERIVED_NAMES as readonly string[]).includes(name)) {
    return { kind: 'derived', derived: name };
  }
  const candidates = [
    ...ctx.params.keys(),
    ...ctx.facts.keys(),
    ...DERIVED_NAMES,
  ];
  const reservedHint = RESERVED.includes(name)
    ? ' that name is reserved for the request itself; conditions can use dayOfWeek, weekday, isWeekend, leadTimeHours or leadTimeDays'
    : '';
  ctx.rep.error(
    'UNKNOWN_REFERENCE',
    `condition name '${name}' is not a parameter, fact or derived value of '${ctx.ownerOfferingId}'`,
    path,
    `known names: ${candidates.join(', ')}${didYouMeanSuffix(name, candidates)}${reservedHint}`,
  );
  return undefined;
}

function compileNameCondition(
  name: string,
  value: unknown,
  path: (string | number)[],
  ctx: ScopeCtx,
): Condition | undefined {
  const resolved = resolveName(name, path, ctx);
  if (!resolved) return undefined;

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `operator object for '${name}' is empty`,
        path,
      );
      return undefined;
    }
    const leaves = entries
      .map(([op, opValue]) => compileOp(name, resolved, op, opValue, [...path, op], ctx))
      .filter(isDefined);
    if (leaves.length === 0) return undefined;
    if (leaves.length === 1) return leaves[0];
    return { op: 'all', conditions: leaves };
  }

  if (Array.isArray(value)) {
    if (!value.every(isScalar)) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `'${name}': list values must be scalars (strings or numbers)`,
        path,
      );
      return undefined;
    }
    const leaf: Condition = {
      ref: resolved.kind,
      name,
      op: 'in',
      value: homogeneousList(name, value, path, ctx),
    };
    checkValues(resolved, 'in', value, path, ctx);
    return leaf;
  }

  if (isScalar(value)) {
    checkValues(resolved, 'eq', value, path, ctx);
    const op =
      resolved.kind === 'parameter' && resolved.param.type === 'multiselect'
        ? 'contains'
        : 'eq';
    return { ref: resolved.kind, name, op, value };
  }

  ctx.rep.error(
    'INVALID_CONDITION',
    `'${name}': condition value must be a scalar, a list of scalars, or an operator object like { gte: 5 }`,
    path,
  );
  return undefined;
}

function compileOp(
  name: string,
  resolved: ResolvedName,
  op: string,
  rawValue: unknown,
  path: (string | number)[],
  ctx: ScopeCtx,
): Condition | undefined {
  if (!(CONDITION_OPS as readonly string[]).includes(op)) {
    ctx.rep.error(
      'INVALID_CONDITION',
      `unknown operator '${op}' for '${name}'`,
      path,
      `valid operators: ${CONDITION_OPS.join(', ')}${didYouMeanSuffix(op, CONDITION_OPS)}`,
    );
    return undefined;
  }

  const ref = resolved.kind;
  if (op === 'exists') {
    if (typeof rawValue === 'boolean') {
      return { ref, name, op: 'exists', value: rawValue };
    }
    ctx.rep.error(
      'INVALID_CONDITION',
      `'exists' takes true or false`,
      path,
    );
    return undefined;
  }
  if (op === 'eq' || op === 'neq' || op === 'contains') {
    if (!isScalar(rawValue)) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `'${op}' takes a scalar value`,
        path,
      );
      return undefined;
    }
    checkValues(resolved, op, rawValue, path, ctx);
    return { ref, name, op, value: rawValue };
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    // Numbers always compare numerically; date/time parameters additionally
    // compare lexically against same-shape ISO strings.
    let value: number | string | undefined;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      value = rawValue;
    } else if (
      typeof rawValue === 'string' &&
      resolved.kind === 'parameter' &&
      resolved.param.type === 'date' &&
      isCalendarDate(rawValue)
    ) {
      value = rawValue;
    } else if (
      typeof rawValue === 'string' &&
      resolved.kind === 'parameter' &&
      resolved.param.type === 'time' &&
      /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(rawValue)
    ) {
      value = rawValue;
    }
    if (value === undefined) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `'${op}' takes a number${resolved.kind === 'parameter' && (resolved.param.type === 'date' || resolved.param.type === 'time') ? ` or a ${resolved.param.type === 'date' ? 'YYYY-MM-DD' : 'HH:MM[:SS]'} string` : ''}`,
        path,
      );
      return undefined;
    }
    checkNumericRef(resolved, op, name, path, ctx);
    return { ref, name, op, value };
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(rawValue) || !rawValue.every(isScalar)) {
      ctx.rep.error(
        'INVALID_CONDITION',
        `'${op}' takes a list of scalars`,
        path,
      );
      return undefined;
    }
    const value = homogeneousList(name, rawValue, path, ctx);
    checkValues(resolved, op, rawValue, path, ctx);
    return { ref, name, op, value };
  }
  // matches
  if (typeof rawValue !== 'string') {
    ctx.rep.error('INVALID_CONDITION', `'matches' takes a regular expression string`, path);
    return undefined;
  }
  const problem = patternError(rawValue);
  if (problem !== undefined) {
    ctx.rep.error('INVALID_CONDITION', `'matches' pattern cannot be used: ${problem}`, path, PATTERN_HINT);
    return undefined;
  }
  return { ref, name, op: 'matches', value: rawValue };
}

/** in/not_in values must be all strings or all numbers for the graph type. */
function homogeneousList(
  name: string,
  values: (string | number | boolean)[],
  path: (string | number)[],
  ctx: ScopeCtx,
): string[] | number[] | undefined {
  const kinds = new Set(values.map((v) => typeof v));
  if (kinds.has('boolean') || kinds.size > 1) {
    ctx.rep.error(
      'INVALID_CONDITION',
      `'${name}': list values must be all strings or all numbers`,
      path,
    );
    return undefined;
  }
  return kinds.has('number') ? (values as number[]) : (values as string[]);
}
