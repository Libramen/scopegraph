/**
 * Compiler diagnostics.
 *
 * Every problem a catalog author (usually a coding agent) can hit is reported
 * as a `Diagnostic` with a stable `code`, an actionable message (what is
 * wrong, where, and how to fix it) and, whenever the name looks like a typo,
 * a `hint` with a "did you mean X?" suggestion.
 *
 * Stable codes (severity is per-use; most are errors):
 * - Load:        MISSING_FILE, MISSING_DIR (warning), YAML_SYNTAX,
 *                INVALID_OFFERING_ID
 * - Business:    SCHEMA, INVALID_TIMEZONE, UNSUPPORTED_CURRENCY,
 *                INVALID_SEASON, RESERVED_NAME, DUPLICATE_ID, INVALID_HANDOFF
 * - Offerings:   SCHEMA, RESERVED_NAME, NAME_COLLISION, INVALID_PARAMETER,
 *                INVALID_OPTION_GROUP, INVALID_CONDITION, UNKNOWN_REFERENCE,
 *                INVALID_RULE, INVALID_PRICING, INVALID_PACKAGE,
 *                UNKNOWN_OFFERING, DUPLICATE_ID, PARAMETER_CONFLICT,
 *                PACKAGE_OPTION_REF
 * - Lint:        NO_PRICE, MISSING_DESCRIPTION,
 *                UNUSED_FACT, FACT_FAIL_OPEN, GATE_ON_INTERNAL,
 *                GATE_ON_REQUIRED_DEFAULT, DISCOUNT_UNBOUNDED_QUANTITY,
 *                DATE_VALUE_WITHOUT_DATE, PERCENT_OF_ZERO_BASE
 */

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Catalog-relative file, e.g. `business.yaml` or `offerings/camp.yaml`. */
  file?: string;
  /** Path inside the file's parsed data, e.g. `['rules', 2, 'when']`. */
  path: (string | number)[];
  /** 1-based, when the source was loaded from YAML. */
  line?: number;
  column?: number;
  hint?: string;
}

/** Resolves a data path to a 1-based YAML position. */
export type Locator = (
  path: (string | number)[],
) => { line: number; column: number } | undefined;

/**
 * Emits diagnostics for one source file, attaching `file` and (when the
 * source came from YAML) `line`/`column` resolved from the diagnostic path.
 */
export class Reporter {
  constructor(
    private readonly out: Diagnostic[],
    private readonly file?: string,
    private readonly locate?: Locator,
  ) {}

  private emit(
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    path: (string | number)[],
    hint: string | undefined,
  ): Diagnostic {
    const pos = this.locate?.(path);
    const diagnostic: Diagnostic = {
      severity,
      code,
      message,
      path,
      ...(this.file !== undefined ? { file: this.file } : {}),
      ...(pos !== undefined ? { line: pos.line, column: pos.column } : {}),
      ...(hint !== undefined ? { hint } : {}),
    };
    this.out.push(diagnostic);
    return diagnostic;
  }

  error(
    code: string,
    message: string,
    path: (string | number)[] = [],
    hint?: string,
  ): Diagnostic {
    return this.emit('error', code, message, path, hint);
  }

  warn(
    code: string,
    message: string,
    path: (string | number)[] = [],
    hint?: string,
  ): Diagnostic {
    return this.emit('warning', code, message, path, hint);
  }
}

// ─── "did you mean" support ──────────────────────────────────────────────────

/** Classic Levenshtein edit distance (small strings; O(len·len)). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Closest candidate within edit distance 2 (alphabetical first on ties), or
 * undefined. Use for typos in names the author should have written.
 */
function didYouMean(
  name: string,
  candidates: readonly string[],
): string | undefined {
  const unique = [...new Set(candidates)].sort();
  let best: string | undefined;
  let bestDistance = 3; // strictly greater than the threshold of 2
  for (const candidate of unique) {
    if (candidate === name) continue;
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** `'x'`-quoted suggestion suffix, or '' when there is none close enough. */
export function didYouMeanSuffix(
  name: string,
  candidates: readonly string[],
): string {
  const suggestion = didYouMean(name, candidates);
  return suggestion === undefined ? '' : ` Did you mean '${suggestion}'?`;
}

// ─── Formatting and ordering ─────────────────────────────────────────────────

/**
 * Human-readable one-liner: `file:line:col error CODE message (hint: …)`.
 * Missing parts are omitted, e.g. `business.yaml:3:7 error INVALID_TIMEZONE …`
 * or `warning UNUSED_FACT …` (lint diagnostics have no source location).
 */
export function formatDiagnostic(d: Diagnostic): string {
  const location = [d.file, d.line, d.column]
    .filter((part) => part !== undefined)
    .join(':');
  const head = location.length > 0 ? `${location} ` : '';
  const hint = d.hint !== undefined ? ` (hint: ${d.hint})` : '';
  return `${head}${d.severity} ${d.code} ${d.message}${hint}`;
}

/**
 * Errors before warnings, then by file (no file last), line and column
 * (no position last). Stable: equal keys keep insertion order.
 */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const rank = (d: Diagnostic): number => (d.severity === 'error' ? 0 : 1);
  const positioned = (d: Diagnostic): number =>
    d.line !== undefined ? 0 : 1;
  return [...diagnostics].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if ((a.file ?? '\uffff') !== (b.file ?? '\uffff')) {
      return (a.file ?? '\uffff') < (b.file ?? '\uffff') ? -1 : 1;
    }
    if (positioned(a) !== positioned(b)) return positioned(a) - positioned(b);
    if ((a.line ?? Number.MAX_SAFE_INTEGER) !== (b.line ?? Number.MAX_SAFE_INTEGER)) {
      return (a.line ?? 0) - (b.line ?? 0);
    }
    return (a.column ?? 0) - (b.column ?? 0);
  });
}
