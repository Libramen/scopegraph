/**
 * Rule compilation: the `rules:` block — exactly one effect per rule
 * (block / require / exclude / ask), target resolution against the offering's
 * own option groups and parameters, and rule-id uniqueness.
 */
import { z } from 'zod';
import { KEY_PATTERN, RuleInput } from '../catalog/schema.js';
import type { Rule, RuleEffect, SelectionTarget } from '../graph/types.js';
import { compileCondition } from './conditions.js';
import type { ScopeCtx } from './context.js';
import { didYouMeanSuffix } from './diagnostics.js';

type RuleData = z.infer<typeof RuleInput>;

export function compileRule(
  raw: RuleData,
  index: number,
  ctx: ScopeCtx,
): Rule | undefined {
  const path = ['rules', index];
  const effects = (['block', 'require', 'exclude', 'ask'] as const).filter(
    (key) => raw[key] !== undefined,
  );
  if (effects.length !== 1) {
    ctx.rep.error(
      'INVALID_RULE',
      effects.length === 0
        ? 'rule has no effect; use exactly one of block / require / exclude / ask'
        : `rule sets ${effects.length} effects (${effects.join(' + ')}); use exactly one`,
      path,
      'split the rule into several rules, one effect each',
    );
    return undefined;
  }
  const effectKey = effects[0]!;
  if (raw.message !== undefined && (effectKey === 'block' || effectKey === 'ask')) {
    ctx.rep.error(
      'INVALID_RULE',
      `'message' applies to require/exclude rules, not '${effectKey}'`,
      [...path, 'message'],
      effectKey === 'block'
        ? "put the refusal text in 'block' itself"
        : "'ask' rules have no buyer-facing message",
    );
    return undefined;
  }

  let effect: RuleEffect | undefined;
  if (effectKey === 'block') {
    effect = { kind: 'block', message: raw.block! };
  } else if (effectKey === 'require' || effectKey === 'exclude') {
    const target = parseTarget(raw[effectKey]!, effectKey, [...path, effectKey], ctx);
    if (!target) return undefined;
    effect =
      effectKey === 'require'
        ? {
            kind: 'require',
            target,
            ...(raw.message !== undefined ? { message: raw.message } : {}),
          }
        : {
            kind: 'exclude',
            target,
            ...(raw.message !== undefined ? { message: raw.message } : {}),
          };
  } else {
    const target = parseAskTarget(raw.ask!, [...path, 'ask'], ctx);
    if (!target) return undefined;
    effect = { kind: 'ask', target };
  }

  const key = raw.id ?? `rule${index + 1}`;
  const id = `${ctx.ownerOfferingId}.${key}`;
  if (ctx.usedIds.has(id)) {
    ctx.rep.error(
      'DUPLICATE_ID',
      `rule id '${key}' is already used in this offering`,
      [...path, 'id'],
      'rule and pricing ids share the <offering>.<id> namespace; rename one',
    );
    return undefined;
  }
  ctx.usedIds.add(id);

  const when =
    raw.when !== undefined
      ? compileCondition(raw.when, [...path, 'when'], ctx)
      : undefined;

  return {
    id,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(when !== undefined ? { when } : {}),
    effect: effect!,
    priority: raw.priority ?? 0,
    active: raw.active ?? true,
    ownerOfferingId: ctx.ownerOfferingId,
  };
}

function parseTarget(
  value: string,
  effectKey: 'require' | 'exclude',
  path: (string | number)[],
  ctx: ScopeCtx,
): SelectionTarget | undefined {
  const segments = value.split('.');
  if (segments.length > 2 || segments.some((segment) => !KEY_PATTERN.test(segment))) {
    ctx.rep.error(
      'INVALID_RULE',
      `${effectKey} target '${value}' must be '<group>' or '<group>.<option>'`,
      path,
    );
    return undefined;
  }
  const groupKey = segments[0]!;
  const group = ctx.ownGroups.get(groupKey);
  if (!group) {
    ctx.rep.error(
      'UNKNOWN_REFERENCE',
      `${effectKey} names unknown option group '${groupKey}'`,
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
        `${effectKey} names unknown option '${value}'`,
        path,
        `options of '${groupKey}': ${group.options.map((o) => o.key).join(', ')}${didYouMeanSuffix(optionKey, group.options.map((o) => o.key))}`,
      );
      return undefined;
    }
    return { type: 'option', id: value };
  }
  return { type: 'group', id: groupKey };
}

function parseAskTarget(
  value: string,
  path: (string | number)[],
  ctx: ScopeCtx,
): { type: 'parameter' | 'group'; id: string } | undefined {
  if (!KEY_PATTERN.test(value)) {
    ctx.rep.error(
      'INVALID_RULE',
      `ask target '${value}' must be a parameter name or an option group key`,
      path,
    );
    return undefined;
  }
  if (ctx.params.has(value)) return { type: 'parameter', id: value };
  if (ctx.ownGroups.has(value)) return { type: 'group', id: value };
  const candidates = [...ctx.params.keys(), ...ctx.ownGroups.keys()];
  ctx.rep.error(
    'UNKNOWN_REFERENCE',
    `ask target '${value}' is neither a parameter nor an option group of '${ctx.ownerOfferingId}'`,
    path,
    `known askable steps: ${candidates.join(', ') || '(none)'}${didYouMeanSuffix(value, candidates)}`,
  );
  return undefined;
}
