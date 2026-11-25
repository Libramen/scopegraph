/**
 * Command implementations for the CLI. Each command takes already-parsed
 * options and returns a process exit code: 0 ok, 1 failure (diagnostics,
 * failed scenarios, blocked evaluation), 2 usage error (raised in index.ts).
 *
 * Human output goes to stdout as plain text with optional ANSI colors
 * (TTY + NO_COLOR unset); --json output is a stable, machine-readable shape
 * documented per command.
 */
import { constants } from 'node:fs';
import { lstat, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { formatDiagnostic, loadGraph } from '../compile/index.js';
import { describeOffering, evaluate, factsContext, listOfferings } from '../engine/index.js';
import type { Diagnostic } from '../compile/diagnostics.js';
import { formatMoney } from '../pricing/index.js';
import type { Graph, Value } from '../graph/types.js';
import { getFacts } from '../extend/facts.js';
import type { FactsContext } from '../extend/facts.js';
import type { ScopeResult } from '../engine/types.js';
import { listScenarioFiles, runScenarioFiles } from '../scenarios/run.js';
import { colorEnabled, createStyle, formatDescription, formatResult, formatTrace, summarizeResult } from './format.js';
import { runInteractive } from './interactive.js';
import { formatGraphDocument, graphDocument } from './graph-export.js';
import type { GraphFormat } from './graph-export.js';
import { renderMermaid } from './mermaid.js';

const out = (text = '') => process.stdout.write(`${text}\n`);
const err = (text = '') => process.stderr.write(`${text}\n`);

/** What `graph --out` may write: graph payloads and docs, never code or other files. */
const GRAPH_OUT_EXTENSIONS: readonly string[] = ['.json', '.yaml', '.yml', '.mmd', '.mermaid', '.md'];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why `graph --out` must not write `out`, or undefined when it may. A target
 * that exists must be a regular file (never a symlink, directory or device)
 * with one link (a hard link could share its contents with a catalog file).
 * Containment is judged by identity, not spelling: every ancestor of the
 * target's real parent directory is compared by device and inode with each
 * guarded directory, so case variants on case-insensitive volumes,
 * `..`-prefixed names and symlinked parents can't slip past.
 */
async function graphOutRefusal(
  out: string,
  guarded: ReadonlyArray<{ dir: string; refusal: string }>,
): Promise<string | undefined> {
  const target = resolve(out);
  try {
    const existing = await lstat(target);
    if (!existing.isFile()) {
      return `--out '${out}' exists and is not a regular file (a symlink, directory or device); refusing to write through it`;
    }
    if (existing.nlink > 1) {
      return `--out '${out}' has other hard links; refusing to overwrite a hard-linked file`;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      return `could not write '${out}': ${messageOf(error)}`;
    }
  }
  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch (error) {
    return `could not write '${out}': ${messageOf(error)}`;
  }
  const identities: Array<{ dev: bigint; ino: bigint; refusal: string }> = [];
  for (const { dir, refusal } of guarded) {
    try {
      const { dev, ino } = await stat(dir, { bigint: true });
      identities.push({ dev, ino, refusal });
    } catch {
      // A directory that doesn't exist contains nothing.
    }
  }
  for (let current = parent; ; current = dirname(current)) {
    const { dev, ino } = await stat(current, { bigint: true });
    const match = identities.find((identity) => identity.dev === dev && identity.ino === ino);
    if (match !== undefined) return match.refusal;
    if (dirname(current) === current) return undefined;
  }
}

/** `graph --out` writes: create or truncate, and never follow a symlink swapped in since the check. */
const GRAPH_OUT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

// ─── Catalog loading ─────────────────────────────────────────────────────────

type CatalogLoad = { ok: true; graph: Graph } | { ok: false; code: number };

/** Shape of `loadGraph`'s result (compile module contract). */
interface CatalogLoadResult {
  graph?: Graph;
  diagnostics: Diagnostic[];
}

/**
 * Load the catalog for a command that needs a graph. On errors (or an
 * unloadable catalog) prints diagnostics and returns the exit code; warnings
 * are printed to stderr but do not stop the command.
 */
async function loadCatalog(catalogDir: string, json: boolean): Promise<CatalogLoad> {
  let loaded: CatalogLoadResult;
  try {
    loaded = await loadGraph(catalogDir);
  } catch (error) {
    if (json) {
      out(
        JSON.stringify(
          {
            ok: false,
            diagnostics: [
              { severity: 'error', code: 'CATALOG_LOAD', message: `could not load catalog from '${catalogDir}': ${messageOf(error)}` },
            ],
          },
          null,
          2,
        ),
      );
    } else {
      err(`error: could not load catalog from '${catalogDir}': ${messageOf(error)}`);
    }
    return { ok: false, code: 1 };
  }
  const diagnostics = loaded.diagnostics;
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (!loaded.graph || hasErrors) {
    if (json) {
      out(JSON.stringify({ ok: false, diagnostics }, null, 2));
    } else {
      for (const diagnostic of diagnostics) err(formatDiagnostic(diagnostic));
      err("catalog has errors — fix them first (run 'validate')");
    }
    return { ok: false, code: 1 };
  }
  if (diagnostics.length > 0 && !json) {
    for (const diagnostic of diagnostics) err(formatDiagnostic(diagnostic));
  }
  return { ok: true, graph: loaded.graph };
}

// ─── validate ────────────────────────────────────────────────────────────────

/** JSON: `{ ok: boolean, diagnostics: Diagnostic[] }`. */
export async function cmdValidate(options: {
  catalogDir: string;
  json: boolean;
  strict: boolean;
}): Promise<number> {
  const { catalogDir, json, strict } = options;
  let diagnostics: Diagnostic[];
  try {
    ({ diagnostics } = await loadGraph(catalogDir));
  } catch (error) {
    if (json) {
      out(
        JSON.stringify(
          {
            ok: false,
            diagnostics: [
              { severity: 'error', code: 'CATALOG_LOAD', message: `could not load catalog from '${catalogDir}': ${messageOf(error)}` },
            ],
          },
          null,
          2,
        ),
      );
    } else {
      err(`error: could not load catalog from '${catalogDir}': ${messageOf(error)}`);
    }
    return 1;
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const ok = errors === 0 && (!strict || warnings === 0);
  if (json) {
    out(JSON.stringify({ ok, diagnostics }, null, 2));
    return ok ? 0 : 1;
  }
  const style = createStyle(colorEnabled());
  for (const diagnostic of diagnostics) out(formatDiagnostic(diagnostic));
  const summary = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
  out(ok ? style.green(`✓ catalog ok (${summary})`) : style.red(`✗ ${summary}`));
  return ok ? 0 : 1;
}

// ─── list ────────────────────────────────────────────────────────────────────

/** JSON: `{ offerings: Array<OfferingListing & { status, bookable }> }`. */
export async function cmdList(options: { catalogDir: string; json: boolean }): Promise<number> {
  const load = await loadCatalog(options.catalogDir, options.json);
  if (!load.ok) return load.code;
  const { graph } = load;
  const offerings = listOfferings(graph).map((summary) => ({
    id: summary.id,
    kind: summary.kind,
    name: summary.name,
    status: graph.offerings[summary.id]?.status ?? 'unknown',
    bookable: graph.offerings[summary.id]?.bookable ?? false,
    priceFrom: summary.priceFrom,
  }));
  if (options.json) {
    out(JSON.stringify({ offerings }, null, 2));
    return 0;
  }
  const style = createStyle(colorEnabled());
  if (offerings.length === 0) {
    out('(no offerings — the catalog is empty)');
    return 0;
  }
  const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
  const rows = offerings.map((offering) => [
    truncate(offering.id, 24),
    offering.kind,
    truncate(offering.name, 36),
    offering.status,
    offering.bookable ? 'yes' : 'no',
    truncate(offering.priceFrom ?? '-', 30),
  ]);
  const headers = ['id', 'kind', 'name', 'status', 'bookable', 'price from'];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ');
  out(style.dim(line(headers)));
  for (const row of rows) out(line(row));
  return 0;
}

// ─── describe ────────────────────────────────────────────────────────────────

/** JSON: the `OfferingDescription` as returned by the engine. */
export async function cmdDescribe(options: {
  catalogDir: string;
  json: boolean;
  offering: string;
}): Promise<number> {
  const load = await loadCatalog(options.catalogDir, options.json);
  if (!load.ok) return load.code;
  const description = describeOffering(load.graph, options.offering);
  if (!description) {
    if (options.json) {
      out(JSON.stringify({ ok: false, error: `offering '${options.offering}' not found` }, null, 2));
    } else {
      err(`error: offering '${options.offering}' not found — run 'list' to see the catalog`);
    }
    return 1;
  }
  if (options.json) {
    out(JSON.stringify(description, null, 2));
  } else {
    out(formatDescription(description, createStyle(colorEnabled())));
  }
  return 0;
}

// ─── simulate ────────────────────────────────────────────────────────────────

/**
 * Resolve facts the way the server does: call the src/extend/facts.ts hook
 * for a listed offering (fault-isolated — a crash degrades to no facts),
 * then merge --facts over it so authors can override single keys.
 */
async function resolveFacts(
  context: FactsContext | undefined,
  offering: string,
  override: Record<string, Value> | undefined,
): Promise<{ facts: Record<string, Value> | undefined; note: string }> {
  let hookFacts: Record<string, Value> = {};
  let hookOk = true;
  if (context !== undefined) {
    try {
      hookFacts = await getFacts(context);
    } catch (error) {
      hookOk = false;
      err(`warning: getFacts failed for offering '${offering}': ${messageOf(error)}`);
    }
  }
  if (override === undefined) {
    return {
      facts: hookFacts,
      note: hookOk
        ? 'facts: from src/extend/facts.ts'
        : 'facts: src/extend/facts.ts failed — none applied',
    };
  }
  return {
    facts: { ...hookFacts, ...override },
    note: hookOk ? 'facts: hook + --facts override' : 'facts: hook failed, --facts only',
  };
}

/** JSON: the `ScopeResult` itself (trace included only with --explain). */
export async function cmdSimulate(options: {
  catalogDir: string;
  json: boolean;
  explain: boolean;
  interactive: boolean;
  offering: string;
  answers?: Record<string, Value>;
  selections?: Record<string, string | string[]>;
  date?: string;
  facts?: Record<string, Value>;
  now?: Date;
}): Promise<number> {
  const load = await loadCatalog(options.catalogDir, options.json);
  if (!load.ok) return load.code;
  const { graph } = load;
  const style = createStyle(options.json ? false : colorEnabled());
  const money = formatMoney;
  const { facts, note } = await resolveFacts(
    factsContext(graph, options.offering, options.date, options.now ?? new Date()),
    options.offering,
    options.facts,
  );
  const request = {
    offering: options.offering,
    answers: options.answers,
    selections: options.selections,
    date: options.date,
    facts,
  };
  if (options.interactive) {
    out(style.dim(note));
    return runInteractive({
      graph,
      evaluate,
      request,
      now: options.now,
      explain: options.explain,
      money,
      style,
      currency: graph.business.currency,
    });
  }
  const result = evaluate(graph, request, { now: options.now, trace: options.explain });
  if (options.json) {
    out(JSON.stringify(result, null, 2));
  } else {
    out(style.dim(note));
    out(formatResult(result, money, style));
    if (options.explain && result.trace) {
      out(formatTrace(result.trace, money, graph.business.currency, style));
    }
  }
  return result.status === 'qualified' || result.status === 'needs_input' ? 0 : 1;
}

// ─── test ────────────────────────────────────────────────────────────────────

function stripTrace(result: ScopeResult): Omit<ScopeResult, 'trace'> {
  const { trace: _stripped, ...clean } = result;
  return clean;
}

/**
 * JSON: `{ ok, passed, failed, skipped, files: [{ file, ok, error?,
 * results: [{ name, ok, skipped?, mismatches, error?, result? }] }] }`
 * (result has its trace stripped).
 */
export async function cmdTest(options: {
  catalogDir: string;
  scenariosDir: string;
  json: boolean;
  filter?: string;
}): Promise<number> {
  const load = await loadCatalog(options.catalogDir, options.json);
  if (!load.ok) return load.code;
  const { graph } = load;
  let files: string[];
  try {
    const stats = await stat(options.scenariosDir);
    files = stats.isFile() ? [options.scenariosDir] : await listScenarioFiles(options.scenariosDir);
  } catch {
    if (options.json) {
      out(
        JSON.stringify(
          { ok: false, error: `no scenarios directory at '${options.scenariosDir}'` },
          null,
          2,
        ),
      );
    } else {
      err(`error: no scenarios directory at '${options.scenariosDir}'`);
    }
    return 1;
  }
  const report = await runScenarioFiles(
    graph,
    files,
    undefined,
    options.filter === undefined ? undefined : { filter: options.filter },
  );
  if (options.json) {
    out(
      JSON.stringify(
        {
          ok: report.ok,
          passed: report.passed,
          failed: report.failed,
          skipped: report.skipped,
          files: report.files.map((file) => ({
            file: file.file,
            ok: file.ok,
            ...(file.error !== undefined ? { error: file.error } : {}),
            results: file.results.map((result) => ({
              name: result.name,
              ok: result.ok,
              ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
              mismatches: result.mismatches,
              ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.result !== undefined ? { result: stripTrace(result.result) } : {}),
            })),
          })),
        },
        null,
        2,
      ),
    );
    return report.ok ? 0 : 1;
  }
  const style = createStyle(colorEnabled());
  for (const file of report.files) {
    if (report.files.length > 1 || file.error !== undefined) out(style.dim(file.file));
    if (file.error !== undefined) out(`  ${style.red('✗')} ${style.red(file.error)}`);
    for (const result of file.results) {
      if (result.skipped) {
        out(`  ${style.dim(`– ${result.name} (skipped)`)}`);
      } else if (result.ok) {
        out(`  ${style.green('✓')} ${result.name}`);
      } else {
        out(`  ${style.red('✗')} ${result.name}`);
        for (const mismatch of result.mismatches) out(`      ${mismatch}`);
        if (result.error !== undefined) out(`      ${result.error}`);
        if (result.result !== undefined) {
          out(`      ${style.dim(summarizeResult(result.result, formatMoney))}`);
        }
      }
    }
  }
  const summary = `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;
  out(report.ok ? style.green(`✓ ${summary}`) : style.red(`✗ ${summary}`));
  return report.ok ? 0 : 1;
}

// ─── graph ───────────────────────────────────────────────────────────────────

/**
 * `--format` picks the payload: mermaid (default) or the compiled graph as
 * json / yaml (see ./graph-export.ts). `--json` keeps its global meaning —
 * a `{ ok, … }` envelope on stdout — and wraps the payload:
 *   mermaid → `{ ok: true, mermaid: string }`
 *   json    → `{ ok: true, graph: GraphDocument }`
 *   yaml    → `{ ok: true, yaml: string }`
 * With `--out <file>` the bare payload is written to the file instead and
 * stdout reports it (`{ ok: true, format, out }` with --json). `--out` only
 * writes `.json`/`.yaml`/`.yml`/`.mmd`/`.md` files, never inside the catalog,
 * scenarios or DATA_DIR directory, and never through a symlink or onto a
 * non-regular file (see graphOutRefusal). Errors: `{ ok: false, error }` with
 * --json, else stderr; exit 1.
 */
export async function cmdGraph(options: {
  catalogDir: string;
  scenariosDir: string;
  /** DATA_DIR (payment records): `--out` never writes inside it. */
  dataDir: string;
  json: boolean;
  format: GraphFormat;
  offering?: string;
  out?: string;
}): Promise<number> {
  const { json, format } = options;
  const fail = (message: string): number => {
    if (json) out(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`error: ${message}`);
    return 1;
  };
  if (options.out !== undefined) {
    const target = resolve(options.out);
    if (!GRAPH_OUT_EXTENSIONS.includes(extname(target).toLowerCase())) {
      return fail(`--out must name a ${GRAPH_OUT_EXTENSIONS.join(' / ')} file, got '${options.out}'`);
    }
    const refusal = await graphOutRefusal(options.out, [
      ...[options.catalogDir, options.scenariosDir].map((dir) => ({
        dir,
        refusal: `--out '${options.out}' is inside ${dir}; refusing to overwrite catalog or scenario files`,
      })),
      {
        dir: options.dataDir,
        refusal: `--out '${options.out}' is inside DATA_DIR (${options.dataDir}); refusing to write over payment records`,
      },
    ]);
    if (refusal !== undefined) return fail(refusal);
  }
  const load = await loadCatalog(options.catalogDir, json);
  if (!load.ok) return load.code;
  let payload: string;
  let envelope: Record<string, unknown>;
  try {
    if (format === 'mermaid') {
      const mermaid = renderMermaid(load.graph, options.offering);
      payload = `${mermaid}\n`;
      envelope = { ok: true, mermaid };
    } else {
      const document = graphDocument(load.graph, options.offering);
      payload = formatGraphDocument(document, format);
      envelope = format === 'json' ? { ok: true, graph: document } : { ok: true, yaml: payload };
    }
  } catch (error) {
    return fail(messageOf(error));
  }
  if (options.out !== undefined) {
    try {
      await writeFile(options.out, payload, { flag: GRAPH_OUT_FLAGS });
    } catch (error) {
      return fail(`could not write '${options.out}': ${messageOf(error)}`);
    }
    if (json) out(JSON.stringify({ ok: true, format, out: options.out }, null, 2));
    else out(`wrote the ${format} graph to ${options.out}`);
  } else if (json) {
    out(JSON.stringify(envelope, null, 2));
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

// ─── serve ───────────────────────────────────────────────────────────────────

export async function cmdServe(options: {
  catalogDir: string;
  port?: number;
  host?: string;
  stdio?: boolean;
  watch?: boolean;
}): Promise<number> {
  // Loaded only to serve: the server pulls in the payments stack and the Stripe
  // SDK, whose import-time side effects every other command must not pay.
  const { runServe } = await import('../server/index.js');
  await runServe({
    catalogDir: options.catalogDir,
    port: options.port,
    host: options.host,
    stdio: options.stdio,
    watch: options.watch,
  });
  return 0;
}
