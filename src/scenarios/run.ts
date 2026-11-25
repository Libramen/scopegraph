/**
 * Scenario runner — evaluates scenario files against a compiled graph and
 * reports pass/fail with the mismatches and the evaluate result (trace
 * included) so failures can be explained.
 *
 * Schema errors are reported per file/scenario (with YAML path context),
 * never thrown: one broken scenario does not hide the others' results.
 */
import { readdir, readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { Graph } from '../graph/types.js';
import { evaluate as defaultEvaluate } from '../engine/index.js';
import type { Evaluate, ScopeResult } from '../engine/types.js';
import { DEFAULT_NOW, Scenario, ScenarioFileDefaults } from './schema.js';
import type { Scenario as ScenarioType } from './schema.js';

/** Pass an evaluator to stub the engine (tests); defaults to the real one. */
export interface ScenarioDeps {
  evaluate: Evaluate;
}

export interface RunOptions {
  /** Keep only scenarios whose name (or file path) contains this, case-insensitive. */
  filter?: string;
}

export interface ScenarioOutcome {
  name: string;
  file: string;
  ok: boolean;
  /** Expectations that did not hold, e.g. "expected total 115.00, got 130.00". */
  mismatches: string[];
  /** Schema error for this scenario (with YAML path), when it could not be run. */
  error?: string;
  /** The evaluate result, trace included — for explaining failures. */
  result?: ScopeResult;
  skipped?: boolean;
}

export interface ScenarioFileReport {
  file: string;
  ok: boolean;
  /** File-level error (unreadable, YAML parse error, bad shape). */
  error?: string;
  results: ScenarioOutcome[];
}

export interface ScenarioReport {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  files: ScenarioFileReport[];
}

// ─── Expectation matching ────────────────────────────────────────────────────

const toCents = (major: number): number => Math.round(major * 100);
const fmtMajor = (major: number): string => major.toFixed(2);

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function describeReason(reason: {
  code: string;
  message: string;
  ruleId?: string;
}): string {
  const rule = reason.ruleId ? ` [${reason.ruleId}]` : '';
  return `${reason.code}${rule} ("${truncate(reason.message, 60)}")`;
}

/** `expect.rule` matches the full rule id or the part after `<offering>.`. */
function matchesRuleId(ruleId: string, expected: string): boolean {
  if (ruleId === expected) return true;
  const dot = ruleId.indexOf('.');
  return dot >= 0 && ruleId.slice(dot + 1) === expected;
}

/**
 * `expect.error` matches the engine's error field (`answers.participants`,
 * `selections.extras`, `date`) or the bare parameter/group/date name.
 */
function matchesErrorField(field: string, expected: string): boolean {
  if (field === expected) return true;
  return (
    (field.startsWith('answers.') || field.startsWith('selections.')) &&
    field.slice(field.indexOf('.') + 1) === expected
  );
}

/** Short hint appended to a status mismatch so the gap is visible at a glance. */
function outcomeHint(result: ScopeResult): string {
  switch (result.status) {
    case 'needs_input':
      return ` (asks '${result.question.key}')`;
    case 'blocked':
      return result.reasons.length ? ` (${result.reasons.map((r) => r.code).join(', ')})` : '';
    case 'invalid':
      return result.errors.length
        ? ` (${result.errors.map((e) => `${e.field}: ${e.code}`).join(', ')})`
        : '';
    case 'unavailable':
      return ` (${result.code})`;
    default:
      return '';
  }
}

function checkLine(
  expected: { id?: string; label?: string; amount?: number },
  lines: ReadonlyArray<{ id: string; label: string; amountCents: number }>,
): boolean {
  return lines.some((line) => {
    if (expected.id !== undefined && line.id !== expected.id) return false;
    if (expected.label !== undefined && line.label !== expected.label) return false;
    if (expected.amount !== undefined && line.amountCents !== toCents(expected.amount)) return false;
    return true;
  });
}

function checkExpectation(expect: ScenarioType['expect'], result: ScopeResult): string[] {
  const mismatches = matchExpectation(expect, result);
  if (
    mismatches.length > 0 &&
    result.status === 'blocked' &&
    result.reasons.some((reason) => reason.code === 'FACTS_UNAVAILABLE')
  ) {
    mismatches.push(
      'hint: scenarios never call src/extend/facts.ts — set facts in the scenario or in defaults.facts',
    );
  }
  return mismatches;
}

function matchExpectation(expect: ScenarioType['expect'], result: ScopeResult): string[] {
  if (result.status !== expect.status) {
    return [`expected status ${expect.status}, got ${result.status}${outcomeHint(result)}`];
  }
  const mismatches: string[] = [];
  switch (result.status) {
    case 'needs_input': {
      if (expect.asks !== undefined && result.question.key !== expect.asks) {
        mismatches.push(`expected question '${expect.asks}', got '${result.question.key}'`);
      }
      break;
    }
    case 'blocked': {
      if (expect.reason !== undefined) {
        const needle = expect.reason.toLowerCase();
        const found = result.reasons.some(
          (r) => r.code === expect.reason || r.message.toLowerCase().includes(needle),
        );
        if (!found) {
          const got = result.reasons.map(describeReason).join('; ') || 'no reasons';
          mismatches.push(`expected a reason matching '${expect.reason}', got ${got}`);
        }
      }
      if (expect.rule !== undefined) {
        const found = result.reasons.some(
          (r) => r.ruleId !== undefined && matchesRuleId(r.ruleId, expect.rule!),
        );
        if (!found) {
          const got =
            result.reasons
              .map((r) => r.ruleId)
              .filter((id): id is string => id !== undefined)
              .join(', ') || 'no rule';
          mismatches.push(`expected blocked by rule '${expect.rule}', got ${got}`);
        }
      }
      break;
    }
    case 'invalid': {
      if (expect.error !== undefined && !result.errors.some((e) => matchesErrorField(e.field, expect.error!))) {
        const got = result.errors.map((e) => e.field).join(', ') || 'no errors';
        mismatches.push(`expected an error on field '${expect.error}', got ${got}`);
      }
      break;
    }
    case 'qualified': {
      const quote = result.quote;
      if (expect.total !== undefined && quote.totalCents !== toCents(expect.total)) {
        mismatches.push(
          `expected total ${fmtMajor(expect.total)}, got ${fmtMajor(quote.totalCents / 100)}`,
        );
      }
      if (expect.subtotal !== undefined && quote.subtotalCents !== toCents(expect.subtotal)) {
        mismatches.push(
          `expected subtotal ${fmtMajor(expect.subtotal)}, got ${fmtMajor(quote.subtotalCents / 100)}`,
        );
      }
      if (expect.tax !== undefined && quote.taxCents !== toCents(expect.tax)) {
        mismatches.push(
          `expected tax ${fmtMajor(expect.tax)}, got ${fmtMajor(quote.taxCents / 100)}`,
        );
      }
      if (expect.lines !== undefined) {
        for (const expectedLine of expect.lines) {
          if (!checkLine(expectedLine, quote.lines)) {
            const key = expectedLine.id ?? expectedLine.label;
            const amount = expectedLine.amount !== undefined ? ` (${fmtMajor(expectedLine.amount)})` : '';
            const quoteKeys = truncate(quote.lines.map((l) => `${l.id} "${l.label}"`).join(', '), 100);
            mismatches.push(
              `expected a quote line matching '${key}'${amount}, quote lines: ${quoteKeys || 'none'}`,
            );
          }
        }
      }
      break;
    }
    default:
      break;
  }
  return mismatches;
}

// ─── Running ─────────────────────────────────────────────────────────────────

/**
 * Evaluate one scenario (file defaults already applied by the caller, if
 * any) and match its expectations. Pure: no I/O, no clock. Pass `evaluate`
 * to stub the engine.
 */
export function runScenario(
  graph: Graph,
  scenario: ScenarioType,
  evaluate: Evaluate = defaultEvaluate,
): { ok: boolean; mismatches: string[]; result: ScopeResult } {
  const result = evaluate(
    graph,
    {
      offering: scenario.offering,
      answers: scenario.answers,
      selections: scenario.selections,
      date: scenario.date,
      facts: scenario.facts,
    },
    { now: new Date(scenario.now ?? DEFAULT_NOW) },
  );
  const mismatches = checkExpectation(scenario.expect, result);
  return { ok: mismatches.length === 0, mismatches, result };
}

// ─── File loading ────────────────────────────────────────────────────────────

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

interface ParsedDocument {
  defaults: z.infer<typeof ScenarioFileDefaults>;
  scenarios: unknown[];
  errors: string[];
}

/** Accept both file shapes and localize errors instead of failing the whole file. */
function parseDocument(doc: unknown): ParsedDocument {
  if (Array.isArray(doc)) {
    return { defaults: {}, scenarios: doc, errors: [] };
  }
  if (doc !== null && typeof doc === 'object' && 'scenarios' in doc) {
    const errors: string[] = [];
    let defaults: ParsedDocument['defaults'] = {};
    if ('defaults' in doc && doc.defaults !== undefined) {
      const check = ScenarioFileDefaults.safeParse(doc.defaults);
      if (check.success) {
        defaults = check.data;
      } else {
        errors.push(...zodIssues(check.error).map((issue) => `defaults.${issue}`));
      }
    }
    if (!Array.isArray(doc.scenarios)) {
      errors.push('scenarios: expected a list of scenarios');
      return { defaults, scenarios: [], errors };
    }
    return { defaults, scenarios: doc.scenarios, errors };
  }
  return {
    defaults: {},
    scenarios: [],
    errors: ['file must be a list of scenarios, or { defaults, scenarios }'],
  };
}

function scenarioName(raw: unknown, index: number): string {
  if (raw !== null && typeof raw === 'object' && 'name' in raw && typeof raw.name === 'string' && raw.name.length > 0) {
    return raw.name;
  }
  return `scenarios[${index}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runScenarioFile(
  graph: Graph,
  file: string,
  evaluate: Evaluate,
  filter?: string,
): Promise<ScenarioFileReport> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { file, ok: false, error: `could not read file: ${errorMessage(error)}`, results: [] };
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return { file, ok: false, error: `YAML parse error: ${errorMessage(error)}`, results: [] };
  }
  const { defaults, scenarios, errors } = parseDocument(doc);
  if (errors.length > 0) {
    return { file, ok: false, error: errors.join('; '), results: [] };
  }

  const needle = filter?.toLowerCase();
  const matches = (name: string): boolean =>
    needle === undefined ||
    name.toLowerCase().includes(needle) ||
    file.toLowerCase().includes(needle);

  const results: ScenarioOutcome[] = [];
  let ok = true;
  for (const [index, raw] of scenarios.entries()) {
    const name = scenarioName(raw, index);
    const check = Scenario.safeParse(raw);
    if (!check.success) {
      results.push({
        name,
        file,
        ok: false,
        mismatches: [],
        error: zodIssues(check.error)
          .map((issue) => `scenarios[${index}].${issue}`)
          .join('; '),
      });
      ok = false;
      continue;
    }
    if (!matches(name)) {
      results.push({ name, file, ok: true, mismatches: [], skipped: true });
      continue;
    }
    const resolved: ScenarioType = {
      ...check.data,
      now: check.data.now ?? defaults.now,
      facts: { ...defaults.facts, ...check.data.facts },
    };
    const outcome = runScenario(graph, resolved, evaluate);
    results.push({
      name,
      file,
      ok: outcome.ok,
      mismatches: outcome.mismatches,
      result: outcome.result,
    });
    if (!outcome.ok) ok = false;
  }
  return { file, ok, results };
}

/**
 * Read, parse and run every scenario file, collecting a full report.
 * File order is preserved; failures never throw.
 */
export async function runScenarioFiles(
  graph: Graph,
  files: string[],
  deps?: ScenarioDeps,
  options?: RunOptions,
): Promise<ScenarioReport> {
  const evaluate = deps?.evaluate ?? defaultEvaluate;
  const fileReports: ScenarioFileReport[] = [];
  for (const file of files) {
    fileReports.push(await runScenarioFile(graph, file, evaluate, options?.filter));
  }
  const outcomes = fileReports.flatMap((report) => report.results);
  const passed = outcomes.filter((o) => o.ok && !o.skipped).length;
  const failed =
    outcomes.filter((o) => !o.ok).length + fileReports.filter((r) => r.error !== undefined).length;
  const skipped = outcomes.filter((o) => o.skipped).length;
  return {
    ok: failed === 0,
    passed,
    failed,
    skipped,
    files: fileReports,
  };
}

/**
 * All `*.yaml` / `*.yml` files under `dir` (recursively), sorted for
 * deterministic output. Throws if `dir` does not exist.
 */
export async function listScenarioFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')),
    )
    .map((entry) =>
      entry.parentPath === '' ? entry.name : `${entry.parentPath}/${entry.name}`,
    )
    .sort();
}
