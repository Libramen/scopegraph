/**
 * Date-derived values — computed from the requested `date`, never asked.
 *
 * All calendar logic is in `business.timezone` (an invalid zone falls back
 * to UTC).
 *
 * Values (only present when a valid date is given):
 * - dayOfWeek     0 = Sunday … 6 = Saturday (business-local calendar day)
 * - weekday       'sun' … 'sat'
 * - isWeekend     Saturday or Sunday
 * - leadTimeHours fractional hours from `now` to the start, clamped ≥ 0
 * - leadTimeDays  whole days from `now` to the start (floored), clamped ≥ 0
 * - isPeak / isOffPeak  any `peak` / `off_peak` season matches the local day
 * - season        name of the first matching season, or 'none' when none match
 *                 (always set once a date is given, so `season != x` decides)
 *
 * Accepted `date` inputs (calendar years 1900–9999; anything else is unparsable):
 * - `YYYY-MM-DD` (date-only): that calendar day in the business timezone. Its
 *   start is the first valid instant of that local day (local midnight, or the
 *   first instant after a DST gap at midnight); lead time is measured to it.
 * - `YYYY-MM-DDTHH:mm[:ss[.fff]]` with `Z` or `±HH:mm`: that exact instant.
 * - The same without an offset: that wall-clock time in the business timezone
 *   (a wall time inside a DST gap is unparsable; an ambiguous one takes the
 *   earlier instant).
 *
 * Past dates (`DateAnalysis.inPast`):
 * - date-time: the instant is before `now` (raw lead < 0).
 * - date-only: the local calendar day is before today's local date. Today is
 *   NOT in the past even though its local midnight is; its clamped lead time is
 *   0, so any positive `minNoticeHours` refuses it as too soon.
 */
import type { Business, Season, Value } from '../graph/types.js';

/** Names derived from the requested date (reserved; never parameters or facts). */
export const DATE_DERIVED_NAMES: readonly string[] = [
  'dayOfWeek',
  'weekday',
  'isWeekend',
  'leadTimeHours',
  'leadTimeDays',
  'isPeak',
  'isOffPeak',
  'season',
];

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends LocalDate {
  hour: number;
  minute: number;
}

export interface DateAnalysis {
  /** Derived values to merge into the evaluation values. */
  values: Record<string, Value>;
  /** Start instant: the date-time itself, or the first instant of the local day. */
  start: Date;
  dateOnly: boolean;
  /** Raw (unclamped, fractional) hours from `now` to `start`; negative when it has begun. */
  rawLeadHours: number;
  /** See the module header for the date-only vs date-time rule. */
  inPast: boolean;
}

/**
 * Derived values for a requested date. Returns `{}` when `date` is unparsable
 * (the engine reports INVALID_DATE before ever relying on this).
 */
export function computeDerivedValues(date: string, now: Date, business: Business): Record<string, Value> {
  return analyzeDate(date, now, business)?.values ?? {};
}

/** Parse + derive in one pass. `undefined` = unparsable date. */
export function analyzeDate(date: string, now: Date, business: Business): DateAnalysis | undefined {
  const timeZone = validZone(business.timezone);
  const parsed = parseRequestedDate(date, timeZone);
  if (!parsed) return undefined;
  const { start, local, dateOnly } = parsed;

  const leadMillis = start.getTime() - now.getTime();
  const dayOfWeek = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const values: Record<string, Value> = {
    dayOfWeek,
    weekday: WEEKDAYS[dayOfWeek] as string,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    leadTimeHours: Math.max(0, leadMillis / MS_PER_HOUR),
    leadTimeDays: Math.max(0, Math.floor(leadMillis / MS_PER_DAY)),
  };

  const matching = business.seasons.filter((s) => seasonMatches(s, local, dayOfWeek));
  values.isPeak = matching.some((s) => s.kind === 'peak');
  values.isOffPeak = matching.some((s) => s.kind === 'off_peak');
  values.season = matching[0]?.name ?? 'none';

  const inPast = dateOnly ? isoDay(local) < isoDay(wallClockIn(now, timeZone)) : leadMillis < 0;
  return { values, start, dateOnly, rawLeadHours: leadMillis / MS_PER_HOUR, inPast };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

function parseRequestedDate(
  value: string,
  timeZone: string,
): { start: Date; local: LocalDate; dateOnly: boolean } | undefined {
  const dateOnly = ISO_DAY.exec(value);
  if (dateOnly) {
    const local = realDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    if (!local) return undefined;
    const start = localDayStart(local, timeZone);
    return start ? { start, local, dateOnly: true } : undefined;
  }

  const m = ISO_DATE_TIME.exec(value);
  if (!m) return undefined;
  const local = realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Math.floor(Number(m[7]) * 1000);
  if (!local || hour > 23 || minute > 59 || second > 59) return undefined;

  let start: Date;
  const offset = m[8];
  if (offset !== undefined) {
    let offsetMinutes = 0;
    if (offset !== 'Z') {
      const oh = Number(offset.slice(1, 3));
      const om = Number(offset.slice(4, 6));
      if (oh > 23 || om > 59) return undefined;
      offsetMinutes = (offset[0] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    start = new Date(Date.UTC(local.year, local.month - 1, local.day, hour, minute, second, ms) - offsetMinutes * 60_000);
  } else {
    const instant = instantOf({ ...local, hour, minute }, timeZone);
    if (!instant) return undefined;
    start = new Date(instant.getTime() + second * 1000 + ms);
  }
  if (Number.isNaN(start.getTime())) return undefined;
  const wall = wallClockIn(start, timeZone);
  return { start, local: { year: wall.year, month: wall.month, day: wall.day }, dateOnly: false };
}

/** A real calendar date in years 1900–9999 (anything else is INVALID_DATE). */
function realDate(year: number, month: number, day: number): LocalDate | undefined {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return undefined;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay ? { year, month, day } : undefined;
}

function isoDay(d: LocalDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

// ─── Seasons ─────────────────────────────────────────────────────────────────

/**
 * Inclusive range on the business-local calendar date plus an optional weekday
 * filter. `YYYY-MM-DD` bounds are absolute; `MM-DD` bounds recur every year and
 * a recurring range whose `from` is after its `to` wraps the year end. A
 * missing bound is open. An empty `days` list matches nothing.
 */
function seasonMatches(season: Season, local: LocalDate, dayOfWeek: number): boolean {
  if (season.days && !season.days.includes(dayOfWeek)) return false;
  const full = isoDay(local);
  const monthDay = full.slice(5);
  const { from, to } = season;
  const recurring = (b: string): boolean => b.length === 5;

  if (from !== undefined && to !== undefined && recurring(from) && recurring(to) && from > to) {
    return monthDay >= from || monthDay <= to;
  }
  if (from !== undefined && (recurring(from) ? monthDay < from : full < from)) return false;
  if (to !== undefined && (recurring(to) ? monthDay > to : full > to)) return false;
  return true;
}

// ─── Time zones ──────────────────────────────────────────────────────────────

const zoneCache = new Map<string, string>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function validZone(timeZone: string): string {
  const cached = zoneCache.get(timeZone);
  if (cached !== undefined) return cached;
  let resolved = 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    resolved = timeZone;
  } catch {
    resolved = 'UTC';
  }
  zoneCache.set(timeZone, resolved);
  return resolved;
}

function wallClockIn(instant: Date, timeZone: string): WallClock {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

/**
 * The instant a wall-clock time in `timeZone` names. Each candidate offset is
 * converted back and compared, so a time skipped by a spring-forward change
 * returns null and a repeated (fall-back) time returns the earlier instant.
 */
function instantOf(wall: WallClock, timeZone: string): Date | null {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsets = new Set<number>();
  for (const sample of [wallAsUtc - 36 * MS_PER_HOUR, wallAsUtc, wallAsUtc + 36 * MS_PER_HOUR]) {
    const local = wallClockIn(new Date(sample), timeZone);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wallAsUtc - offset))
    .filter((candidate) => {
      const rt = wallClockIn(candidate, timeZone);
      return (
        rt.year === wall.year &&
        rt.month === wall.month &&
        rt.day === wall.day &&
        rt.hour === wall.hour &&
        rt.minute === wall.minute
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

/** The first instant of a local day (some zones skip midnight on a DST change). */
function localDayStart(date: LocalDate, timeZone: string): Date | null {
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const instant = instantOf(
      { ...date, hour: Math.floor(minute / 60), minute: minute % 60 },
      timeZone,
    );
    if (instant) return instant;
  }
  return null;
}
