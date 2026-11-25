/**
 * Business compilation: business.yaml's identity (name, currency, timezone,
 * tax, handoff, payments), facts with reserved-name checks, and seasons —
 * absolute, recurring and weekday-only date ranges.
 */
import { z } from 'zod';
import { BusinessInput, SeasonInput } from '../catalog/schema.js';
import type { Business, FactDef, Season } from '../graph/types.js';
import { isTwoDecimalCurrency, unsupportedCurrencyMessage } from '../pricing/currency.js';
import { RESERVED, WEEKDAYS, isRealMonthDay, percentToMicros } from './context.js';
import type { Reporter } from './diagnostics.js';

type BusinessData = z.infer<typeof BusinessInput>;
type SeasonData = z.infer<typeof SeasonInput>;

export function compileBusiness(data: BusinessData, rep: Reporter): Business {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: data.timezone });
  } catch {
    rep.error(
      'INVALID_TIMEZONE',
      `timezone '${data.timezone}' is not a valid IANA timezone`,
      ['timezone'],
      'use an IANA name such as America/Los_Angeles or Europe/Lisbon',
    );
  }

  if (!isTwoDecimalCurrency(data.currency)) {
    rep.error(
      'UNSUPPORTED_CURRENCY',
      unsupportedCurrencyMessage(data.currency),
      ['currency'],
      'use a two-decimal currency such as USD, EUR or GBP',
    );
  }

  const facts: Record<string, FactDef> = {};
  for (const [name, input] of Object.entries(data.facts ?? {})) {
    if (RESERVED.includes(name)) {
      rep.error(
        'RESERVED_NAME',
        `fact name '${name}' is reserved by the system`,
        ['facts', name],
        'reserved names are derived by the engine or used by the condition grammar; pick another name',
      );
      continue;
    }
    facts[name] = {
      name,
      type: input.type,
      description: input.description,
      required: input.required,
    };
  }

  const seasons: Season[] = [];
  const seasonNames = new Set<string>();
  for (const [index, input] of (data.seasons ?? []).entries()) {
    const path = ['seasons', index];
    if (seasonNames.has(input.name)) {
      rep.error(
        'DUPLICATE_ID',
        `season '${input.name}' is declared more than once`,
        path,
        'merge the two season entries or rename one',
      );
      continue;
    }
    seasonNames.add(input.name);
    const season = compileSeason(input, path, rep);
    if (season) seasons.push(season);
  }

  if (data.handoff?.url !== undefined) checkHandoffUrl(data.handoff.url, rep);

  const business: Business = {
    name: data.name,
    description: data.description,
    website: data.website,
    currency: data.currency,
    timezone: data.timezone,
    ...(data.taxRate !== undefined
      ? { taxRateMicros: percentToMicros(data.taxRate) }
      : {}),
    facts,
    seasons,
    disclosure: data.disclosure,
    handoff: data.handoff,
    payments: data.payments,
  };
  return business;
}

/**
 * The handoff URL is sent to buyer agents as the one next action, so it must
 * be an absolute http(s) URL once its `{placeholder}`s are filled, and its
 * scheme, host and port must be literal: filling every placeholder with two
 * different stand-ins must give the same origin.
 */
function checkHandoffUrl(template: string, rep: Reporter): void {
  const origin = (standIn: string): string | undefined => {
    try {
      const url = new URL(template.replace(/\{[a-z_]+\}/g, standIn));
      return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}` : undefined;
    } catch {
      return undefined; // not an absolute URL
    }
  };
  const first = origin('x');
  const problem =
    first === undefined
      ? 'must be an absolute http(s) URL'
      : first !== origin('y')
        ? 'must have a literal scheme, host and port (no placeholders before the path)'
        : undefined;
  if (problem === undefined) return;
  rep.error(
    'INVALID_HANDOFF',
    `handoff.url ${problem}, got '${template}'`,
    ['handoff', 'url'],
    'e.g. https://book.example.com/{offering}?total={total}&{params}',
  );
}

function compileSeason(
  input: SeasonData,
  path: (string | number)[],
  rep: Reporter,
): Season | undefined {
  if (input.name === 'none') {
    rep.error(
      'INVALID_SEASON',
      "season name 'none' is reserved: the engine reports season 'none' when a date matches no season",
      path,
      'rename the season, e.g. off_season',
    );
    return undefined;
  }
  const fromOk =
    input.from === undefined
      ? { year: undefined as number | undefined, ok: true }
      : parseSeasonDate(input.from);
  const toOk =
    input.to === undefined
      ? { year: undefined as number | undefined, ok: true }
      : parseSeasonDate(input.to);
  if (input.from !== undefined && !fromOk.ok) {
    rep.error(
      'INVALID_SEASON',
      `season '${input.name}': 'from' (${input.from}) is not a real calendar date`,
      [...path, 'from'],
      'use YYYY-MM-DD or MM-DD; check the month/day actually exist',
    );
  }
  if (input.to !== undefined && !toOk.ok) {
    rep.error(
      'INVALID_SEASON',
      `season '${input.name}': 'to' (${input.to}) is not a real calendar date`,
      [...path, 'to'],
      'use YYYY-MM-DD or MM-DD; check the month/day actually exist',
    );
  }
  if (
    input.from !== undefined &&
    input.to !== undefined &&
    fromOk.ok &&
    toOk.ok &&
    (fromOk.year !== undefined) !== (toOk.year !== undefined)
  ) {
    rep.error(
      'INVALID_SEASON',
      `season '${input.name}' mixes absolute and recurring dates`,
      path,
      "use YYYY-MM-DD for both (one-off) or MM-DD for both (every year; from > to wraps the year end)",
    );
  }
  if (
    input.from !== undefined &&
    input.to !== undefined &&
    fromOk.ok &&
    toOk.ok &&
    fromOk.year !== undefined &&
    toOk.year !== undefined &&
    input.from > input.to
  ) {
    rep.error(
      'INVALID_SEASON',
      `season '${input.name}': 'from' (${input.from}) is after 'to' (${input.to})`,
      [...path, 'from'],
      'absolute seasons must start before they end; wrap-around is only supported for recurring MM-DD dates',
    );
  }
  const hasRange = input.from !== undefined || input.to !== undefined;
  if (!hasRange && (input.days ?? []).length === 0) {
    rep.warn(
      'INVALID_SEASON',
      `season '${input.name}' has no dates and no days; it never matches`,
      path,
      "add 'from'/'to' or 'days'",
    );
  }
  return {
    name: input.name,
    kind: input.kind,
    from: input.from,
    to: input.to,
    ...(input.days !== undefined
      ? { days: input.days.map((d) => WEEKDAYS.indexOf(d)) }
      : {}),
  };
}

/** Validates one `YYYY-MM-DD` / `MM-DD` string and reports its year-ness. */
function parseSeasonDate(
  value: string,
): { ok: false } | { ok: true; year: number | undefined } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    return isRealMonthDay(match[2]!, match[3]!, Number(match[1]))
      ? { ok: true, year: Number(match[1]) }
      : { ok: false };
  }
  const recurring = /^(\d{2})-(\d{2})$/.exec(value);
  if (recurring && isRealMonthDay(recurring[1]!, recurring[2]!)) {
    return { ok: true, year: undefined };
  }
  return { ok: false };
}
