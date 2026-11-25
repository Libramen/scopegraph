/**
 * Shared compilation context: the diagnostics `Session`, the per-offering
 * `OwnParts` record, the name-resolution `ScopeCtx` used by rules and pricing
 * conditions, and the small constants and value helpers every compiler
 * module reuses (money/percent conversion, calendar-date checks, …).
 */
import { z } from 'zod';
import {
  AdjustmentInput,
  OfferingInput,
  RESERVED_NAMES,
} from '../catalog/schema.js';
import type {
  Adjustment,
  BaseLine,
  Business,
  FactDef,
  OfferingScope,
  OptionGroup,
  Parameter,
} from '../graph/types.js';
import { Reporter } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import type { SourceInfo } from './load.js';

export type OfferingData = z.infer<typeof OfferingInput>;
export type AdjustmentData = z.infer<typeof AdjustmentInput>;

export const RESERVED: readonly string[] = RESERVED_NAMES;

/** Derived values the engine computes (see RESERVED_NAMES in schema.ts). */
export const DERIVED_NAMES = [
  'dayOfWeek',
  'weekday',
  'isWeekend',
  'leadTimeHours',
  'leadTimeDays',
  'isPeak',
  'isOffPeak',
  'season',
] as const;

export const NUMERIC_DERIVED: readonly string[] = ['dayOfWeek', 'leadTimeHours', 'leadTimeDays'];

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const DEFAULT_ORDER: Record<Adjustment['kind'], number> = {
  addon: 100,
  discount: 200,
  surcharge: 300,
  fee: 400,
};

export function moneyToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function percentToMicros(percent: number): number {
  return Math.round(percent * 10000);
}

/** 'party_size' → 'Party size'. */
export function humanize(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** `YYYY-MM-DD` that exists on the calendar (so `2026-02-30` is rejected). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  return isRealMonthDay(match[2]!, match[3]!, Number(match[1]));
}

/** `MM-DD` that exists (checked against a leap year so Feb 29 is allowed). */
export function isRealMonthDay(month: string, day: string, year?: number): boolean {
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return false;
  const monthLength = new Date(Date.UTC(year ?? 2024, m, 0)).getUTCDate();
  return d <= monthLength;
}

/** One compilation run: a shared diagnostics sink plus per-source reporters. */
export class Session {
  readonly diagnostics: Diagnostic[] = [];

  repFor(file: string | undefined, info: SourceInfo | undefined): Reporter {
    return new Reporter(this.diagnostics, file, info?.locate);
  }

  get hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }
}

/** Everything known about an offering after its own parts are compiled. */
export interface OwnParts {
  id: string;
  file: string;
  info?: SourceInfo;
  data: OfferingData;
  params: Parameter[];
  groups: OptionGroup[];
  base?: BaseLine;
  bundleDiscount?: OfferingScope['bundleDiscount'];
  contains: Array<{
    offeringId: string;
    quantity: number;
    path: (string | number)[];
  }>;
  /** Option-price `per` refs, validated once the scope's parameters are known. */
  deferredOptionPer: Array<{
    param: string;
    what: string;
    path: (string | number)[];
  }>;
  /** Option `pricing:` entries, compiled once the scope's parameters are known. */
  deferredOptionPricing: Array<{
    optionId: string;
    entries: AdjustmentData[];
    path: (string | number)[];
  }>;
  /** Base-price `per` ref, validated once the scope's parameters are known. */
  deferredBasePer?: { param: string; path: (string | number)[] };
}

/** Name-resolution scope for one offering's rules / pricing conditions. */
export interface ScopeCtx {
  ownerOfferingId: string;
  params: Map<string, Parameter>;
  facts: Map<string, FactDef>;
  seasons: Set<string>;
  /** The declaring offering's own option groups (never flattened). */
  ownGroups: Map<string, OptionGroup>;
  usedIds: Set<string>;
  rep: Reporter;
}

export function makeCtx(
  parts: OwnParts,
  scopeParams: Parameter[],
  business: Business,
  rep: Reporter,
): ScopeCtx {
  return {
    ownerOfferingId: parts.id,
    params: new Map(scopeParams.map((p) => [p.name, p])),
    facts: new Map(Object.entries(business.facts)),
    seasons: new Set(business.seasons.map((s) => s.name)),
    ownGroups: new Map(parts.groups.map((g) => [g.key, g])),
    usedIds: new Set(),
    rep,
  };
}

/** What a condition name resolved to, for value validation. */
export type ResolvedName =
  | { kind: 'parameter'; param: Parameter }
  | { kind: 'fact'; fact: FactDef }
  | { kind: 'derived'; derived: string };
