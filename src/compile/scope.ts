/**
 * Scope assembly: products compile their own scope; packages flatten the
 * scopes of the products they contain — merging identical parameters and
 * reporting conflicts — re-check contained rules' option references
 * (PACKAGE_OPTION_REF) and assemble the final `Offering` objects.
 */
import type {
  Business,
  Condition,
  Offering,
  OfferingScope,
  Parameter,
} from '../graph/types.js';
import { isDefined, makeCtx, moneyToCents } from './context.js';
import type { OwnParts, ScopeCtx, Session } from './context.js';
import { didYouMeanSuffix } from './diagnostics.js';
import { compileAdjustment, validatePer } from './pricing.js';
import { compileRule } from './rules.js';

/** Structural signature used to merge identical flattened parameters. */
function paramSignature(p: Parameter): string {
  return JSON.stringify([
    p.name,
    p.label,
    p.description ?? null,
    p.type,
    p.required,
    p.options ?? null,
    p.min ?? null,
    p.max ?? null,
    p.pattern ?? null,
    p.default ?? null,
    p.role ?? null,
    p.internal,
  ]);
}

export function productScope(
  parts: OwnParts,
  business: Business,
  session: Session,
): OfferingScope {
  const rep = session.repFor(parts.file, parts.info);
  const ctx = makeCtx(parts, parts.params, business, rep);
  const rules = (parts.data.rules ?? [])
    .map((rule, index) => compileRule(rule, index, ctx))
    .filter(isDefined);
  const adjustments = (parts.data.pricing ?? [])
    .map((entry, index) => compileAdjustment(entry, index, ctx))
    .filter(isDefined);
  validateDeferredPer(parts, ctx);
  compileDeferredOptionPricing(parts, ctx);
  return {
    parameters: parts.params,
    optionGroups: parts.groups,
    rules,
    adjustments,
    baseLines: parts.base !== undefined ? [parts.base] : [],
    inactiveContents: [],
  };
}

/** Group key referenced by an `option` condition leaf ('g.o' → 'g'). */
function optionGroupKeyOf(optionId: string): string {
  return optionId.includes('.') ? optionId.split('.')[0]! : optionId;
}

/** Group keys of every `option` leaf in a condition tree. */
function collectOptionRefs(condition: Condition): string[] {
  const groups: string[] = [];
  const visit = (node: Condition): void => {
    if (node.conditions !== undefined) {
      node.conditions.forEach(visit);
      return;
    }
    if (node.ref === 'option' && node.name !== undefined) {
      groups.push(optionGroupKeyOf(node.name));
    }
  };
  visit(condition);
  return groups;
}

export function packageScope(
  parts: OwnParts,
  business: Business,
  ownById: Map<string, OwnParts>,
  scopeById: Map<string, OfferingScope>,
  session: Session,
): { scope: OfferingScope; contains: Array<{ offeringId: string; quantity: number }> } {
  const rep = session.repFor(parts.file, parts.info);

  // Resolve contains against compiled products
  const contained: Array<{
    parts: OwnParts;
    scope: OfferingScope;
    quantity: number;
  }> = [];
  const containsOut: Array<{ offeringId: string; quantity: number }> = [];
  const seen = new Set<string>();
  for (const item of parts.contains) {
    if (item.offeringId === parts.id) {
      rep.error(
        'INVALID_PACKAGE',
        "a package cannot contain itself",
        item.path,
      );
      continue;
    }
    const target = ownById.get(item.offeringId);
    if (!target) {
      const invalid = [...ownById.keys()];
      rep.error(
        'UNKNOWN_OFFERING',
        `contains references '${item.offeringId}', which is not a valid compiled offering`,
        item.path,
        `known offerings: ${invalid.join(', ') || '(none)'}${didYouMeanSuffix(item.offeringId, invalid)}`,
      );
      continue;
    }
    if (target.data.kind !== 'product') {
      rep.error(
        'INVALID_PACKAGE',
        `contains references '${item.offeringId}', which is a package; packages can only contain products`,
        item.path,
      );
      continue;
    }
    if (seen.has(item.offeringId)) {
      rep.error(
        'INVALID_PACKAGE',
        `'${item.offeringId}' is listed more than once in contains`,
        item.path,
        "set its quantity instead of repeating it",
      );
      continue;
    }
    seen.add(item.offeringId);
    const scope = scopeById.get(item.offeringId);
    if (scope) {
      contained.push({ parts: target, scope, quantity: item.quantity });
      containsOut.push({ offeringId: item.offeringId, quantity: item.quantity });
    }
  }

  // Flatten parameters: own first, then contained products' in contains order
  const parameters: Parameter[] = [];
  const byName = new Map<string, { param: Parameter; source: OwnParts }>();
  const addParam = (param: Parameter, source: OwnParts): void => {
    const existing = byName.get(param.name);
    if (!existing) {
      byName.set(param.name, { param, source });
      parameters.push(param);
      return;
    }
    if (paramSignature(existing.param) === paramSignature(param)) return;
    session
      .repFor(existing.source.file, existing.source.info)
      .error(
        'PARAMETER_CONFLICT',
        `parameter '${param.name}' is defined differently by '${existing.source.id}' and '${source.id}'`,
        ['ask', param.name],
        'make the definitions identical (type, options, bounds, default) so they merge, or rename one',
      );
    session
      .repFor(source.file, source.info)
      .error(
        'PARAMETER_CONFLICT',
        `parameter '${param.name}' is defined differently by '${source.id}' and '${existing.source.id}'`,
        ['ask', param.name],
        'make the definitions identical (type, options, bounds, default) so they merge, or rename one',
      );
  };
  for (const param of parts.params) addParam(param, parts);
  for (const item of contained) {
    for (const param of item.scope.parameters) addParam(param, item.parts);
  }

  // Own rules/pricing/conditions resolve against the flattened parameter scope
  const ctx = makeCtx(parts, parameters, business, rep);
  const ownRules = (parts.data.rules ?? [])
    .map((rule, index) => compileRule(rule, index, ctx))
    .filter(isDefined);
  const ownAdjustments = (parts.data.pricing ?? [])
    .map((entry, index) => compileAdjustment(entry, index, ctx))
    .filter(isDefined);
  validateDeferredPer(parts, ctx);
  compileDeferredOptionPricing(parts, ctx);

  const rules = [...ownRules, ...contained.flatMap((item) => item.scope.rules)];
  const adjustments = [
    ...ownAdjustments,
    ...contained.flatMap((item) => item.scope.adjustments),
  ];

  // Contained products keep their rules, but option references must resolve
  // against groups the package itself offers (option groups never flatten).
  const ownGroupKeys = new Set(parts.groups.map((g) => g.key));
  for (const item of contained) {
    const productRep = session.repFor(item.parts.file, item.parts.info);
    const checkRefs = (
      when: Condition | undefined,
      effectTarget: string | undefined,
      path: (string | number)[],
    ): void => {
      const groups = new Set<string>(
        effectTarget !== undefined ? [effectTarget] : [],
      );
      if (when !== undefined) {
        for (const ref of collectOptionRefs(when)) groups.add(ref);
      }
      for (const groupKey of groups) {
        if (!ownGroupKeys.has(groupKey)) {
          productRep.error(
            'PACKAGE_OPTION_REF',
            `'${item.parts.id}' is contained in '${parts.id}' but references option group '${groupKey}', which the package does not offer; buyers can never select it`,
            path,
            `move the rule to the package, or give the package its own '${groupKey}' option group`,
          );
        }
      }
    };
    item.scope.rules.forEach((rule, index) => {
      const effectTarget =
        rule.effect.kind === 'require' || rule.effect.kind === 'exclude'
          ? rule.effect.target.type === 'group'
            ? rule.effect.target.id
            : optionGroupKeyOf(rule.effect.target.id)
          : undefined;
      checkRefs(rule.when, effectTarget, ['rules', index]);
    });
    item.scope.adjustments.forEach((adjustment, index) => {
      checkRefs(adjustment.when, undefined, ['pricing', index]);
    });
    // Option-owned pricing (price sugar has no `when`; authored entries may).
    for (const group of item.parts.groups) {
      for (const option of group.options) {
        for (const adjustment of option.adjustments) {
          if (adjustment.when === undefined) continue;
          checkRefs(adjustment.when, undefined, [
            'choose',
            group.key,
            'options',
            option.key,
            'pricing',
            adjustment.id.split('.').pop()!,
          ]);
        }
      }
    }
  }

  const baseLines =
    parts.base !== undefined
      ? [parts.base]
      : contained.flatMap((item) =>
          item.scope.baseLines.map((line) => ({
            ...line,
            quantity: line.quantity * item.quantity,
          })),
        );

  const inactiveContents = contained
    .filter((item) => item.parts.data.status !== 'active')
    .map((item) => item.parts.id);

  return {
    scope: {
      parameters,
      optionGroups: parts.groups,
      rules,
      adjustments,
      baseLines,
      ...(parts.bundleDiscount !== undefined
        ? { bundleDiscount: parts.bundleDiscount }
        : {}),
      inactiveContents,
    },
    contains: containsOut,
  };
}

function validateDeferredPer(parts: OwnParts, ctx: ScopeCtx): void {
  for (const ref of parts.deferredOptionPer) {
    validatePer(ref.param, ref.what, ref.path, ctx, 'nonnegative');
  }
  if (parts.deferredBasePer) {
    validatePer(
      parts.deferredBasePer.param,
      `base price of '${parts.id}'`,
      parts.deferredBasePer.path,
      ctx,
      'positive',
    );
  }
}

/** Compiles `pricing:` entries authored on options into their adjustments. */
function compileDeferredOptionPricing(parts: OwnParts, ctx: ScopeCtx): void {
  for (const item of parts.deferredOptionPricing) {
    const option = parts.groups
      .flatMap((group) => group.options)
      .find((candidate) => candidate.id === item.optionId);
    if (!option) continue;
    const compiled = item.entries
      .map((entry, index) => compileAdjustment(entry, index, ctx, item.optionId))
      .filter(isDefined);
    option.adjustments.push(...compiled);
  }
}

export function buildOffering(
  parts: OwnParts,
  scope: OfferingScope,
  contains: Array<{ offeringId: string; quantity: number }>,
): Offering {
  const data = parts.data;
  return {
    id: parts.id,
    kind: data.kind,
    name: data.name,
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.category !== undefined ? { category: data.category } : {}),
    keywords: data.keywords,
    status: data.status,
    bookable: data.bookable,
    contains,
    date: data.date,
    ...(data.minNoticeHours !== undefined
      ? { minNoticeHours: data.minNoticeHours }
      : {}),
    ...(data.minimumSpend !== undefined
      ? {
          minimumSpend: {
            amountCents: moneyToCents(data.minimumSpend.amount),
            mode: data.minimumSpend.mode,
          },
        }
      : {}),
    scope,
  };
}
