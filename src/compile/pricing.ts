/**
 * Pricing compilation: base price lines (`price:` fixed or per-unit, package
 * `discount`), and `pricing:` adjustments — amount, percent, per-unit, tiered
 * tables and formulas — with `per:` parameter validation and tier checks.
 */
import type {
  Adjustment,
  AdjustmentMethod,
  BaseLine,
} from '../graph/types.js';
import { parseFormula } from '../pricing/index.js';
import { compileCondition } from './conditions.js';
import { DEFAULT_ORDER, moneyToCents, percentToMicros } from './context.js';
import type { AdjustmentData, OwnParts, ScopeCtx } from './context.js';
import { didYouMeanSuffix } from './diagnostics.js';
import type { Reporter } from './diagnostics.js';

const NUMERIC_TYPES: readonly string[] = ['number', 'integer'];

export function compileBaseAndKind(parts: OwnParts, rep: Reporter): void {
  const data = parts.data;
  const base = (
    amount: number,
    per?: string,
  ): BaseLine => ({
    offeringId: parts.id,
    label: data.name,
    amountCents: moneyToCents(amount),
    ...(per !== undefined ? { per } : {}),
    quantity: 1,
    taxable: data.taxable ?? true,
  });

  if (data.price !== undefined) {
    if (typeof data.price === 'number' || data.price.per === undefined) {
      const amount = typeof data.price === 'number' ? data.price : data.price.amount;
      parts.base = base(amount);
    } else {
      parts.base = base(data.price.amount, data.price.per);
      parts.deferredBasePer = {
        param: data.price.per,
        path: ['price', 'per'],
      };
    }
  }

  if (data.kind === 'product') {
    if ((data.contains ?? []).length > 0) {
      rep.error(
        'INVALID_PACKAGE',
        "product offering cannot use 'contains' (that is for packages)",
        ['contains'],
        "set 'kind: package', or remove 'contains'",
      );
    }
    if (data.discount !== undefined) {
      rep.error(
        'INVALID_PACKAGE',
        "product offering cannot use 'discount' (that is for packages priced as a sum)",
        ['discount'],
        "apply discounts with a 'pricing' entry instead",
      );
    }
    if (data.price === undefined) {
      rep.error(
        'INVALID_PRICING',
        "product offering requires a 'price'",
        ['price'],
        "e.g. price: 64 or per-unit price: { amount: 25, per: days }",
      );
    }
    parts.contains = [];
  } else {
    if ((data.contains ?? []).length === 0) {
      rep.error(
        'INVALID_PACKAGE',
        "package offering requires a non-empty 'contains' list",
        ['contains'],
        'list the products inside, e.g. contains: [surf-lesson]',
      );
      parts.contains = [];
    } else {
      parts.contains = data.contains!.map((entry, index) =>
        typeof entry === 'string'
          ? { offeringId: entry, quantity: 1, path: ['contains', index] }
          : {
              offeringId: entry.offering,
              quantity: entry.quantity,
              path: ['contains', index],
            },
      );
    }
    if (data.price !== undefined && data.discount !== undefined) {
      rep.error(
        'INVALID_PRICING',
        "package sets both 'price' and 'discount'; price it either as a fixed 'price' or as a sum with 'discount'",
        ['discount'],
      );
    }
    if (data.discount !== undefined) {
      const { percent, amount } = data.discount;
      const methods = [percent, amount].filter((v) => v !== undefined).length;
      if (methods !== 1) {
        rep.error(
          'INVALID_PRICING',
          "package 'discount' needs exactly one of percent or amount",
          ['discount'],
        );
      } else if (percent !== undefined) {
        parts.bundleDiscount = { type: 'percent', rateMicros: percentToMicros(percent) };
      } else {
        parts.bundleDiscount = { type: 'fixed', amountCents: moneyToCents(amount!) };
      }
    }
  }
}

export function compileAdjustment(
  raw: AdjustmentData,
  index: number,
  ctx: ScopeCtx,
  ownerOptionId?: string,
): Adjustment | undefined {
  const path =
    ownerOptionId !== undefined
      ? [...optionPricingPath(ownerOptionId), index]
      : ['pricing', index];
  const hasAmount = raw.amount !== undefined;
  const hasPercent = raw.percent !== undefined;
  const hasPer = raw.per !== undefined;
  const hasTiers = raw.tiers !== undefined && raw.tiers.length > 0;
  const hasFormula = raw.formula !== undefined;

  let method: AdjustmentMethod | undefined;
  if (hasFormula && !hasAmount && !hasPercent && !hasPer && !hasTiers) {
    const parsed = parseFormula(raw.formula!);
    if (!parsed.ok) {
      ctx.rep.error(
        'INVALID_PRICING',
        `formula does not parse: ${parsed.message}`,
        [...path, 'formula'],
      );
    } else {
      for (const dependency of parsed.dependencies) {
        const param = ctx.params.get(dependency);
        if (!param) {
          ctx.rep.error(
            'UNKNOWN_REFERENCE',
            `formula references '${dependency}' which is not a parameter in scope`,
            [...path, 'formula'],
            `known parameters: ${[...ctx.params.keys()].join(', ') || '(none)'}${didYouMeanSuffix(dependency, [...ctx.params.keys()])}`,
          );
        } else if (!NUMERIC_TYPES.includes(param.type)) {
          ctx.rep.error(
            'INVALID_PRICING',
            `formula dependency '${dependency}' is a ${param.type} parameter; formulas need number or integer parameters`,
            [...path, 'formula'],
          );
        } else if (param.min === undefined || param.min < 0) {
          ctx.rep.error(
            'INVALID_PRICING',
            `formula dependency '${dependency}' must declare min ≥ 0 (negative quantities fail pricing)`,
            [...path, 'formula'],
            `add 'min: 0' (or higher) to the parameter '${dependency}'`,
          );
        }
      }
    }
    method = parsed.ok
      ? { type: 'formula', expression: raw.formula!, dependencies: parsed.dependencies }
      : undefined;
  } else if (hasPercent && !hasAmount && !hasPer && !hasTiers && !hasFormula) {
    method = { type: 'percent', rateMicros: percentToMicros(raw.percent!), basis: raw.basis ?? 'running' };
  } else if (hasAmount && !hasPercent && !hasTiers && !hasFormula) {
    // amount alone → fixed; amount + per → per-unit
    if (hasPer) {
      const perOk = validatePer(raw.per!, `${raw.label} (${index + 1}. pricing entry)`, [...path, 'per'], ctx, 'nonnegative');
      method = perOk
        ? { type: 'per_unit', amountCents: moneyToCents(raw.amount!), per: raw.per! }
        : undefined;
    } else {
      method = { type: 'fixed', amountCents: moneyToCents(raw.amount!) };
    }
  } else if (hasTiers && hasPer && !hasAmount && !hasPercent && !hasFormula) {
    const perOk = validatePer(raw.per!, `${raw.label} (${index + 1}. pricing entry)`, [...path, 'per'], ctx, 'nonnegative');
    const tiers = perOk ? compileTiers(raw, path, ctx) : undefined;
    method = tiers
      ? { type: 'tiered', per: raw.per!, tiers }
      : undefined;
  } else {
    ctx.rep.error(
      'INVALID_PRICING',
      `pricing entry '${raw.label}' does not select exactly one method`,
      path,
      'use one of: amount | percent | amount + per | tiers + per | formula',
    );
  }

  if (raw.basis !== undefined && method?.type !== 'percent') {
    ctx.rep.error(
      'INVALID_PRICING',
      `'basis' only applies to percent adjustments`,
      [...path, 'basis'],
    );
  }

  const key = raw.id ?? `pricing${index + 1}`;
  const id =
    ownerOptionId !== undefined
      ? `${ctx.ownerOfferingId}.${ownerOptionId}.${key}`
      : `${ctx.ownerOfferingId}.${key}`;
  if (ctx.usedIds.has(id)) {
    ctx.rep.error(
      'DUPLICATE_ID',
      `pricing id '${key}' is already used in this offering`,
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
    label: raw.label,
    kind: raw.kind,
    method: method ?? {
      type: 'fixed',
      amountCents: 0,
    },
    ...(when !== undefined ? { when } : {}),
    taxable: raw.taxable ?? true,
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    order: raw.order ?? DEFAULT_ORDER[raw.kind],
    ownerOfferingId: ctx.ownerOfferingId,
    ...(ownerOptionId !== undefined ? { ownerOptionId } : {}),
  };
}

/** ['choose', group, 'options', option, 'pricing'] for option-owned ids. */
function optionPricingPath(optionId: string): (string | number)[] {
  const [groupKey, optionKey] = optionId.split('.');
  return ['choose', groupKey!, 'options', optionKey!, 'pricing'];
}

export function validatePer(
  param: string,
  what: string,
  path: (string | number)[],
  ctx: ScopeCtx,
  minRule: 'positive' | 'nonnegative',
): boolean {
  const target = ctx.params.get(param);
  if (!target) {
    ctx.rep.error(
      'UNKNOWN_REFERENCE',
      `${what} uses per: ${param}, which is not a parameter in scope`,
      path,
      `known parameters: ${[...ctx.params.keys()].join(', ') || '(none)'}${didYouMeanSuffix(param, [...ctx.params.keys()])}`,
    );
    return false;
  }
  if (target.internal) {
    ctx.rep.error(
      'INVALID_PRICING',
      `${what} uses per: ${param}, but '${param}' is internal; per-unit lines show their quantity on the quote`,
      path,
      'use a fixed amount or a formula instead',
    );
    return false;
  }
  if (!NUMERIC_TYPES.includes(target.type)) {
    ctx.rep.error(
      'INVALID_PRICING',
      `${what} uses per: ${param}, but that parameter is a ${target.type}; per-unit pricing needs number or integer`,
      path,
    );
    return false;
  }
  if (minRule === 'positive' && (target.min === undefined || target.min <= 0)) {
    ctx.rep.error(
      'INVALID_PRICING',
      `${what} is priced per '${param}', which must declare min > 0 (a missing or zero count would price nothing)`,
      path,
      `add 'min: 1' (or higher) to the parameter '${param}'`,
    );
    return false;
  }
  if (
    minRule === 'nonnegative' &&
    (target.min === undefined || target.min < 0)
  ) {
    ctx.rep.error(
      'INVALID_PRICING',
      `${what} is priced per '${param}', which must declare min ≥ 0 (negative quantities fail pricing)`,
      path,
      `add 'min: 0' (or higher) to the parameter '${param}'`,
    );
    return false;
  }
  return true;
}

function compileTiers(
  raw: AdjustmentData,
  path: (string | number)[],
  ctx: ScopeCtx,
): Array<{ from: number; to?: number; amountCents: number }> | undefined {
  const tiers = raw.tiers!;
  let ok = true;
  tiers.forEach((tier, index) => {
    if (tier.to !== undefined && tier.to <= tier.from) {
      ctx.rep.error(
        'INVALID_PRICING',
        `tier ${index + 1}: 'to' (${tier.to}) must be greater than 'from' (${tier.from})`,
        [...path, 'tiers', index, 'to'],
      );
      ok = false;
    }
  });

  const sorted = tiers
    .map((tier, index) => ({ tier, index }))
    .sort((a, b) => a.tier.from - b.tier.from);

  const fractional = ctx.params.get(raw.per!)?.type === 'number';
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    if (current.tier.to === undefined && i < sorted.length - 1) {
      ctx.rep.error(
        'INVALID_PRICING',
        `tier ${current.index + 1} has no 'to' but is not the last tier; nothing after it can match`,
        [...path, 'tiers', current.index, 'to'],
        "only the last tier may omit 'to'",
      );
      ok = false;
      break;
    }
    const previous = i > 0 ? sorted[i - 1]! : undefined;
    if (previous) {
      if (previous.tier.to !== undefined && current.tier.from <= previous.tier.to) {
        ctx.rep.error(
          'INVALID_PRICING',
          `tier ${current.index + 1} (from ${current.tier.from}) overlaps the previous tier (to ${previous.tier.to})`,
          [...path, 'tiers', current.index, 'from'],
        );
        ok = false;
      } else if (previous.tier.to !== undefined && fractional) {
        // Tiers are inclusive and may not overlap, so a fractional value
        // between one tier's 'to' and the next 'from' (3.5 in 0–3, 4–7) has no tier.
        ctx.rep.warn(
          'INVALID_PRICING',
          `'${raw.per!}' is a number parameter: no tier covers values between ${previous.tier.to} and ${current.tier.from}; pricing fails closed for those`,
          [...path, 'tiers', current.index, 'from'],
          `make '${raw.per!}' an integer parameter (tiers are inclusive whole-number ranges)`,
        );
      } else if (previous.tier.to !== undefined && current.tier.from > previous.tier.to + 1) {
        ctx.rep.warn(
          'INVALID_PRICING',
          `no tier covers quantities ${previous.tier.to + 1}–${current.tier.from - 1}; pricing fails closed for those`,
          [...path, 'tiers', current.index, 'from'],
          'make the tiers contiguous or extend the previous tier',
        );
      }
    }
  }
  const first = sorted[0];
  if (first && first.tier.from > 0) {
    ctx.rep.warn(
      'INVALID_PRICING',
      `no tier covers quantities below ${first.tier.from}; pricing fails closed for those`,
      [...path, 'tiers', first.index, 'from'],
      "start the first tier at from: 0 unless small quantities should be refused",
    );
  }

  if (!ok) return undefined;
  return sorted.map(({ tier }) => ({
    from: tier.from,
    ...(tier.to !== undefined ? { to: tier.to } : {}),
    amountCents: moneyToCents(tier.amount),
  }));
}
