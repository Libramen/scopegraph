/**
 * Scenario files — executable specs for a catalog.
 *
 * A scenario file (`*.yaml` / `*.yml`) is either a bare list of scenarios or
 * an object with file-wide defaults:
 *
 *   - name: weekday tour for ten
 *     offering: city-tour
 *     answers: { participants: 10 }
 *     selections: { extras: linen }
 *     date: 2026-07-04
 *     expect:
 *       status: qualified
 *       total: 115.00
 *
 *   defaults: { now: 2026-01-01T00:00:00Z, facts: { vip: true } }
 *   scenarios: [ ... ]
 *
 * Conventions:
 * - Money in `expect` (`total`, `subtotal`, `tax`, line `amount`) is written
 *   in major currency units, e.g. `115.5` means $115.50.
 * - `now` defaults to the file default, else 2026-01-01T00:00:00Z, so every
 *   scenario is deterministic: date-derived values (lead time, seasons,
 *   weekday) never drift with the wall clock.
 * - `expect` fields are checked in addition to `status`; unknown keys are
 *   rejected so typos fail loudly instead of silently passing.
 */
import { z } from 'zod';

/** Used when neither the scenario nor its file sets `now`. */
export const DEFAULT_NOW = '2026-01-01T00:00:00Z';

/** An answer / fact value (mirrors the engine's `Value`). */
const ScenarioValue = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);
export type ScenarioValue = z.infer<typeof ScenarioValue>;

const IsoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: `expected an ISO 8601 instant, e.g. ${DEFAULT_NOW}`,
});

/** One expected quote line; matched as a subset of the actual quote. */
const LineExpectation = z
  .object({
    /** Quote line id (adjustment / base line id). */
    id: z.string().optional(),
    /** Quote line label. */
    label: z.string().optional(),
    /** Major currency units, e.g. `15.5` = $15.50. */
    amount: z.number().finite().optional(),
  })
  .strict()
  .refine((v) => v.id !== undefined || v.label !== undefined, {
    message: 'a line expectation needs `id` or `label`',
  });
export type LineExpectation = z.infer<typeof LineExpectation>;

const Expectation = z
  .object({
    status: z.enum(['qualified', 'needs_input', 'blocked', 'invalid', 'unavailable']),
    /** `needs_input`: the key of the question that should be asked. */
    asks: z.string().optional(),
    /**
     * `blocked`: matches a reason code exactly (`RULE`, `MINIMUM_SPEND`,
     * `DATE_TOO_SOON`, …) or is a case-insensitive substring of a reason
     * message.
     */
    reason: z.string().optional(),
    /** `blocked`: the rule id that blocked — full id (`tour.rule1`) or key (`rule1`). */
    rule: z.string().optional(),
    /** `invalid`: the request field the error should be about. */
    error: z.string().optional(),
    /** `qualified`: expected total in major units. */
    total: z.number().finite().optional(),
    /** `qualified`: expected pre-tax subtotal in major units. */
    subtotal: z.number().finite().optional(),
    /** `qualified`: expected tax in major units. */
    tax: z.number().finite().optional(),
    /** `qualified`: expected quote lines (subset match; extras are allowed). */
    lines: z.array(LineExpectation).optional(),
  })
  .strict()
  .superRefine((expect, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (expect.status !== 'needs_input' && expect.asks !== undefined) {
      issue('asks', '`asks` only applies to expect.status: needs_input');
    }
    if (expect.status !== 'blocked' && expect.reason !== undefined) {
      issue('reason', '`reason` only applies to expect.status: blocked');
    }
    if (expect.status !== 'blocked' && expect.rule !== undefined) {
      issue('rule', '`rule` only applies to expect.status: blocked');
    }
    if (expect.status !== 'invalid' && expect.error !== undefined) {
      issue('error', '`error` only applies to expect.status: invalid');
    }
    if (expect.status !== 'qualified') {
      for (const key of ['total', 'subtotal', 'tax', 'lines'] as const) {
        if (expect[key] !== undefined) {
          issue(key, `\`${key}\` only applies to expect.status: qualified`);
        }
      }
    }
  });
export type Expectation = z.infer<typeof Expectation>;

export const Scenario = z
  .object({
    name: z.string().min(1, 'give the scenario a name'),
    offering: z.string().min(1, 'which offering to evaluate'),
    /** Parameter answers keyed by parameter name. */
    answers: z.record(z.string(), ScenarioValue).optional(),
    /** Option selections keyed by group key: an option key or a list. */
    selections: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    /** ISO 8601 date or date-time, as the buyer would send it. */
    date: z.string().optional(),
    /** Server-side facts for this scenario. */
    facts: z.record(z.string(), ScenarioValue).optional(),
    /** Evaluation instant; defaults to the file default, then DEFAULT_NOW. */
    now: IsoInstant.optional(),
    expect: Expectation,
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

/** File-wide defaults applied to every scenario in the file. */
export const ScenarioFileDefaults = z
  .object({
    now: IsoInstant.optional(),
    facts: z.record(z.string(), ScenarioValue).optional(),
  })
  .strict();
export type ScenarioFileDefaults = z.infer<typeof ScenarioFileDefaults>;

/** The whole file: a bare list of scenarios, or `{ defaults?, scenarios }`. */
export const ScenarioFile = z.union([
  z.array(Scenario),
  z
    .object({
      defaults: ScenarioFileDefaults.optional(),
      scenarios: z.array(Scenario),
    })
    .strict(),
]);
export type ScenarioFile = z.infer<typeof ScenarioFile>;
