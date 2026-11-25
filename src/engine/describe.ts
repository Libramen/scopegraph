/**
 * Public catalog views: `listOfferings` (list_offerings) and
 * `describeOffering` (describe_offering). Only active, bookable offerings are
 * visible; internal parameters are never shown. `factsContext` applies the
 * same visibility to what the facts hook may see.
 */
import type { FactsContext } from '../extend/facts.js';
import type { Graph, Offering, OptionGroup } from '../graph/types.js';
import { formatMoney, quantityUnit } from '../pricing/index.js';
import { analyzeDate } from './derived.js';
import { choiceQuestion, parameterQuestion } from './evaluate.js';
import type { BuyerOfferingDescription, OfferingDescription, OfferingListing } from './types.js';

function isListed(offering: Offering): boolean {
  return offering.status === 'active' && offering.bookable;
}

/**
 * The facts-hook input for one request, or undefined when the offering is not
 * listed (the hook is then not called). A date that does not parse is dropped:
 * unknown offering ids and malformed dates never reach a forker's data source.
 */
export function factsContext(graph: Graph, offering: string, date: string | undefined, now: Date): FactsContext | undefined {
  const found = Object.hasOwn(graph.offerings, offering) ? graph.offerings[offering] : undefined;
  if (found === undefined || !isListed(found)) return undefined;
  if (date === undefined || analyzeDate(date, now, graph.business) === undefined) return { offering, business: graph.business };
  return { offering, date, business: graph.business };
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/**
 * Number of query tokens that match the offering's name / description /
 * keywords / category words, case-insensitively. A token matches a word when
 * it is a prefix of the word ("surf" → "surfing"), or the word (≥ 3 chars) is
 * a prefix of the token ("lessons" → "lesson").
 */
function matchScore(offering: Offering, tokens: string[]): number {
  const haystack = words(
    [offering.name, offering.description ?? '', offering.category ?? '', ...offering.keywords].join(' '),
  );
  return tokens.filter((t) => haystack.some((w) => w.startsWith(t) || (w.length >= 3 && t.startsWith(w)))).length;
}

/**
 * Active, bookable offerings in catalog order. With a `query`, only offerings
 * matching at least one query token, best matches first (ties keep catalog order).
 */
export function listOfferings(graph: Graph, query?: string): OfferingListing[] {
  const listed = Object.values(graph.offerings).filter(isListed);
  const tokens = query === undefined ? [] : words(query);
  if (tokens.length === 0) return listed.map((o) => summarize(graph, o));
  return listed
    .map((offering, index) => ({ offering, index, score: matchScore(offering, tokens) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((m) => summarize(graph, m.offering));
}

/**
 * What a buyer agent may see of one offering (describe_offering, GET
 * /api/offerings/:id), per `business.disclosure`: under `progressive` (the
 * default) an overview without questions or choices — scope_offering asks
 * one question at a time; under `menu` the full description.
 */
export function describeOfferingForBuyers(graph: Graph, id: string): BuyerOfferingDescription | undefined {
  const full = describeOffering(graph, id);
  if (full === undefined) return undefined;
  if (graph.business.disclosure === 'menu') return { ...full, disclosure: 'menu' };
  const { questions: _questions, choices: _choices, ...overview } = full;
  return {
    ...overview,
    disclosure: 'progressive',
    next: `Scope this offering with what the buyer has told you (MCP: scope_offering; HTTP: POST /api/offerings/${full.id}/scope); it asks one question at a time.`,
  };
}

/** Full description (owner-facing CLI, and buyers under `disclosure: menu`), or `undefined` when the offering is not listed. */
export function describeOffering(graph: Graph, id: string): OfferingDescription | undefined {
  const offering = Object.hasOwn(graph.offerings, id) ? graph.offerings[id] : undefined;
  if (!offering || !isListed(offering)) return undefined;
  const scope = offering.scope;
  const gated = askTargets(offering);
  return {
    ...summarize(graph, offering),
    currency: graph.business.currency,
    timezone: graph.business.timezone,
    date: offering.date,
    ...(offering.minNoticeHours !== undefined ? { minNoticeHours: offering.minNoticeHours } : {}),
    ...(offering.kind === 'package'
      ? {
          contains: offering.contains.map((c) => ({
            offering: c.offeringId,
            name: graph.offerings[c.offeringId]?.name ?? c.offeringId,
            quantity: c.quantity,
          })),
        }
      : {}),
    questions: scope.parameters
      .filter((p) => !p.internal)
      .map((p) => (gated.has(`parameter:${p.name}`) ? { ...parameterQuestion(p), conditional: true as const } : parameterQuestion(p))),
    choices: scope.optionGroups.map((g) => {
      const choice = choiceQuestion(g, graph.business.currency);
      return gated.has(`group:${g.key}`) ? { ...choice, conditional: true as const } : choice;
    }),
  };
}

function summarize(graph: Graph, offering: Offering): OfferingListing {
  const priceFrom = describePriceFrom(graph, offering);
  return {
    id: offering.id,
    kind: offering.kind,
    name: offering.name,
    ...(offering.description !== undefined ? { description: offering.description } : {}),
    ...(offering.category !== undefined ? { category: offering.category } : {}),
    keywords: [...offering.keywords],
    ...(priceFrom !== undefined ? { priceFrom } : {}),
  };
}

/** `parameter:<name>` / `group:<key>` for every step an active `ask` rule targets. */
function askTargets(offering: Offering): Set<string> {
  const gated = new Set<string>();
  for (const rule of offering.scope.rules) {
    if (rule.active && rule.effect.kind === 'ask') gated.add(`${rule.effect.target.type}:${rule.effect.target.id}`);
  }
  return gated;
}

/**
 * The least a required, always-asked single choice adds: the cheapest option's
 * unconditional fixed adjustments (discounts negative). Undefined when some
 * option's price is conditional or not a fixed amount — no honest floor then.
 */
function cheapestOptionCents(group: OptionGroup): number | undefined {
  let cheapest: number | undefined;
  for (const option of group.options) {
    let cents = 0;
    for (const adjustment of option.adjustments) {
      if (adjustment.when !== undefined || adjustment.method.type !== 'fixed') return undefined;
      cents += adjustment.kind === 'discount' ? -adjustment.method.amountCents : adjustment.method.amountCents;
    }
    cheapest = cheapest === undefined ? cents : Math.min(cheapest, cents);
  }
  return cheapest;
}

/**
 * "From" price built from the base lines (no offering adjustments, no tax):
 * fixed parts summed, per-unit parts summed per `per` parameter, e.g.
 * "$64.00 × participants" or "$200.00 + $15.00 × guests". A percent bundle
 * discount scales every base part; a fixed one reduces the fixed part (never
 * below zero). Each required single choice that is always asked adds its
 * cheapest option (so a `price: 0` offering priced by its choice never reads
 * "$0.00"). When a minimum spend applies and the smallest possible request
 * (every per-unit parameter at its `min`) is below it, the minimum spend is
 * the "from" price. Undefined when there are no base lines.
 */
function describePriceFrom(graph: Graph, offering: Offering): string | undefined {
  const scope = offering.scope;
  if (scope.baseLines.length === 0) return undefined;
  let fixed = 0;
  let hasFixed = false;
  const perUnit = new Map<string, number>();
  for (const line of scope.baseLines) {
    const amount = line.amountCents * line.quantity;
    if (line.per === undefined) {
      fixed += amount;
      hasFixed = true;
    } else {
      perUnit.set(line.per, (perUnit.get(line.per) ?? 0) + amount);
    }
  }
  const discount = scope.bundleDiscount;
  const scale = (cents: number): number =>
    discount?.type === 'percent' ? Math.round((cents * (1_000_000 - discount.rateMicros)) / 1_000_000) : cents;
  fixed = scale(fixed);
  if (discount?.type === 'fixed' && hasFixed) fixed = Math.max(0, fixed - discount.amountCents);

  const gated = askTargets(offering);
  for (const group of scope.optionGroups) {
    const required = group.required || group.minSelections > 0;
    if (group.mode !== 'single' || !required || gated.has(`group:${group.key}`)) continue;
    const cheapest = cheapestOptionCents(group);
    if (cheapest === undefined || cheapest === 0) continue;
    fixed = Math.max(0, fixed + cheapest);
    hasFixed = true;
  }

  const currency = graph.business.currency;
  const minimum = offering.minimumSpend;
  if (minimum !== undefined) {
    let smallest = fixed;
    for (const [per, cents] of perUnit) {
      smallest += scale(cents) * (scope.parameters.find((p) => p.name === per)?.min ?? 0);
    }
    if (smallest < minimum.amountCents) return formatMoney(minimum.amountCents, currency);
  }

  const parts: string[] = [];
  if (hasFixed && (fixed > 0 || perUnit.size === 0)) parts.push(formatMoney(fixed, currency));
  for (const [per, cents] of perUnit) {
    parts.push(`${formatMoney(scale(cents), currency)} × ${quantityUnit(per)}`);
  }
  return parts.join(' + ');
}
