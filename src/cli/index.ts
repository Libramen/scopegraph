#!/usr/bin/env node
/**
 * scopegraph CLI.
 *
 *   validate / list / describe / simulate / test / graph / serve / orders /
 *   init / doctor / mcp-config
 *
 * Human output is plain text (ANSI colors only on a TTY with NO_COLOR unset);
 * --json output is a stable machine-readable shape (see each command in
 * ./commands.ts and ./orders.ts). Exit codes: 0 ok, 1 failed
 * validation/tests/evaluation, 2 usage error.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Value } from '../graph/types.js';
import * as commands from './commands.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { runOrders } from './orders.js';
import { runMcpConfig } from './mcp-config.js';
import { GRAPH_FORMATS } from './graph-export.js';
import type { GraphFormat } from './graph-export.js';
import { CHECKOUT_ROOT, loadEnvFileInto } from './env-file.js';

const USAGE = `scopegraph — graph-based scoping for agentic commerce

Usage:
  scopegraph [options] <command> [args]
  (in a fork of this repo: npm run sg -- <command>)
  init                     Scaffold a fresh starter catalog + scenarios
  doctor                   Pre-flight checklist: catalog, payments, Stripe, server
  validate                 Check the catalog and print diagnostics
  list                     List offerings (id, kind, name, status, bookable, price from)
  describe <offering>      Describe one offering: questions, choices, contents
  simulate <offering>      Evaluate one request; --interactive asks in the terminal
  test                     Run scenario files and report pass/fail per scenario
  graph                    Print the catalog as a mermaid flowchart, or the
                           compiled graph as JSON/YAML (--format)
  serve                    Serve over HTTP (API + MCP), or MCP over stdio with --stdio
  mcp-config               Print a Claude Desktop / MCP client config for this checkout
  orders                   Manage payment orders (list, show, approve, reject)
  help                     Show this help

Global options:
  --catalog <dir>          Catalog directory (env SCOPEGRAPH_CATALOG, default ./catalog)
  --json                   Machine-readable output (stable shapes for agents)
  -h, --help               Show this help

Command options:
  init
    --dir <dir>            Target project directory (default .)
    --name <n>             Business name (default 'My Business')
    --currency <ISO>       ISO 4217 currency (default USD)
    --timezone <tz>        IANA timezone (default UTC)
    --tax-rate <pct>       Sales tax percent (default none)
    --payments <mode>      off | owner_approves | instant (default off)
    --force                Replace a non-empty catalog/ without asking
    --yes                  Non-interactive: accept defaults for missing flags
  doctor
    --offline              Skip the online Stripe/server checks
  validate
    --strict               Exit non-zero on warnings too
  describe <offering>
    (offering id is positional)
  simulate <offering>
    --answers <json>       Parameter answers, e.g. '{"surfers": 2}'
    --selections <json>    Choices by option group, e.g. '{"<group>": "<option>"}' (a list for multi)
    --facts <json>         Override facts on top of the src/extend/facts.ts hook
    --date <iso>           Requested date, e.g. 2026-07-04 or 2026-07-04T09:00:00-07:00
    --now <iso>            Evaluation instant (default: the current time)
    --explain              Show why: values used, rule trace, pricing trace
    --interactive          Ask the questions in the terminal until a final status
  test
    --scenarios <dir|file> Scenarios directory or single file
                           (env SCOPEGRAPH_SCENARIOS, default ./scenarios)
    --filter <substr>      Run only scenarios whose name contains this
  graph
    --offering <id>        Render one offering only
    --format <f>           mermaid (default) | json | yaml — json/yaml are the
                           compiled graph, the exact model the engine evaluates
    --out <file>           Write the output to a .json/.yaml/.yml/.mmd/.md file instead of
                           stdout (never inside the catalog or scenarios directory)
    (with --json, stdout is an envelope: {ok, mermaid} | {ok, graph} | {ok, yaml},
     or {ok, format, out} with --out)
  serve
    --port <n>             HTTP port
    --host <addr>          HTTP bind address
    --stdio                MCP over stdio instead of HTTP
    --watch                Reload the catalog when files change
  orders list|show|approve|reject   (admin API; bearer ADMIN_TOKEN, see docs/payments.md)
    --url <base>           Server base URL (default http://localhost:$PORT)
    --status <s>           list: only orders in this status
    --reason <r>           reject: why (stored on the order)

Scenario files (YAML, list or { defaults, scenarios }) describe requests and
expectations; see docs/catalog-format.md. Scenario "now" defaults to the file
default, else 2026-01-01T00:00:00Z — scenarios are deterministic.

The .env next to scopegraph's package.json is loaded first (never one in the
working directory, and not at all with NODE_ENV=production); variables
already set in the environment win and NODE_* keys in it are ignored.

Exit codes: 0 ok · 1 failed validation/tests/evaluation · 2 usage error

Examples:
  scopegraph init --yes
  scopegraph doctor --offline
  scopegraph validate --strict
  scopegraph list --json
  scopegraph describe surf-lesson
  scopegraph simulate surf-lesson --answers '{"surfers": 2}' --date 2026-07-04 --explain
  scopegraph simulate surf-lesson --interactive
  scopegraph test --scenarios ./scenarios --filter weekend
  scopegraph graph --offering surf-lesson
  scopegraph graph --format json --out graph.json
  scopegraph serve --port 3000
  scopegraph serve --stdio
  scopegraph orders list --status awaiting_approval
`;

/** Thrown for CLI misuse; printed with usage, exit code 2. */
class UsageError extends Error {}

const CLI_OPTIONS = {
  catalog: { type: 'string' },
  dir: { type: 'string' },
  name: { type: 'string' },
  currency: { type: 'string' },
  timezone: { type: 'string' },
  'tax-rate': { type: 'string' },
  payments: { type: 'string' },
  force: { type: 'boolean' },
  yes: { type: 'boolean' },
  offline: { type: 'boolean' },
  json: { type: 'boolean' },
  strict: { type: 'boolean' },
  answers: { type: 'string' },
  selections: { type: 'string' },
  date: { type: 'string' },
  facts: { type: 'string' },
  now: { type: 'string' },
  explain: { type: 'boolean' },
  interactive: { type: 'boolean' },
  scenarios: { type: 'string' },
  filter: { type: 'string' },
  offering: { type: 'string' },
  format: { type: 'string' },
  out: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  stdio: { type: 'boolean' },
  watch: { type: 'boolean' },
  status: { type: 'string' },
  reason: { type: 'string' },
  url: { type: 'string' },
  help: { type: 'boolean', short: 'h' },

} as const;

type CliParse = { options: typeof CLI_OPTIONS; allowPositionals: true; args?: string[] };
type CliPositionals = ReturnType<typeof parseArgs<CliParse>>['positionals'];
type CliValues = ReturnType<typeof parseArgs<CliParse>>['values'];

function parseJsonObject(flag: string | undefined, what: string): Record<string, unknown> | undefined {
  if (flag === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(flag);
  } catch (error) {
    throw new UsageError(
      `${what} is not valid JSON (${error instanceof Error ? error.message : String(error)}): '${flag}'`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${what} must be a JSON object, e.g. '{"key": "value"}'`);
  }
  return parsed as Record<string, unknown>;
}

function parsePort(flag: string | undefined): number | undefined {
  if (flag === undefined) return undefined;
  if (!/^\d+$/.test(flag)) throw new UsageError(`--port must be a number, got '${flag}'`);
  return Number(flag);
}

function parseNow(flag: string | undefined): Date | undefined {
  if (flag === undefined) return undefined;
  const ms = Date.parse(flag);
  if (Number.isNaN(ms)) throw new UsageError(`--now is not a valid ISO 8601 instant: '${flag}'`);
  return new Date(ms);
}

function isGraphFormat(value: string): value is GraphFormat {
  return (GRAPH_FORMATS as readonly string[]).includes(value);
}

export async function main(argv: string[]): Promise<number> {
  let values: CliValues;
  let positionals: CliPositionals;
  try {
    const parsed = parseArgs<CliParse>({ options: CLI_OPTIONS, allowPositionals: true, args: argv });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = positionals[0] ?? 'help';
  const catalogDir = values.catalog ?? process.env.SCOPEGRAPH_CATALOG ?? './catalog';
  const json = Boolean(values.json);

  switch (command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;

    case 'init': {
      if (positionals.length > 1) {
        throw new UsageError('init takes no positional arguments — everything is a flag (see --help)');
      }
      return runInit({
        ...(values.dir !== undefined && { dir: values.dir }),
        ...(values.name !== undefined && { name: values.name }),
        ...(values.currency !== undefined && { currency: values.currency }),
        ...(values.timezone !== undefined && { timezone: values.timezone }),
        ...(values['tax-rate'] !== undefined && { taxRate: values['tax-rate'] }),
        ...(values.payments !== undefined && { payments: values.payments }),
        ...(values.force !== undefined && { force: Boolean(values.force) }),
        ...(values.yes !== undefined && { yes: Boolean(values.yes) }),
      });
    }

    case 'doctor':
      return runDoctor({ catalogDir, json, offline: Boolean(values.offline) });

    case 'validate':
      return commands.cmdValidate({ catalogDir, json, strict: Boolean(values.strict) });

    case 'list':
      return commands.cmdList({ catalogDir, json });

    case 'describe': {
      const offering = positionals[1];
      if (offering === undefined) {
        throw new UsageError("describe needs an offering id — run 'list' to see the catalog");
      }
      return commands.cmdDescribe({ catalogDir, json, offering });
    }

    case 'simulate': {
      const offering = positionals[1] ?? values.offering;
      if (offering === undefined) {
        throw new UsageError("simulate needs an offering id — run 'list' to see the catalog");
      }
      if (values.interactive && json) {
        throw new UsageError('--interactive asks questions in the terminal; it cannot be combined with --json');
      }
      if (values.interactive && !process.stdin.isTTY) {
        throw new UsageError(
          '--interactive needs a terminal (stdin is not a TTY) — pass the request as flags instead: --answers <json>, --selections <json>, --date <iso>',
        );
      }
      const answers = parseJsonObject(values.answers, '--answers');
      const selections = parseJsonObject(values.selections, '--selections');
      const facts = parseJsonObject(values.facts, '--facts');
      return commands.cmdSimulate({
        catalogDir,
        json,
        explain: Boolean(values.explain),
        interactive: Boolean(values.interactive),
        offering,
        ...(answers !== undefined && { answers: answers as Record<string, Value> }),
        ...(selections !== undefined && {
          selections: selections as Record<string, string | string[]>,
        }),
        ...(values.date !== undefined && { date: values.date }),
        ...(facts !== undefined && { facts: facts as Record<string, Value> }),
        ...(values.now !== undefined && { now: parseNow(values.now) }),
      });
    }

    case 'test': {
      const scenariosDir = values.scenarios ?? process.env.SCOPEGRAPH_SCENARIOS ?? './scenarios';
      return commands.cmdTest({
        catalogDir,
        scenariosDir,
        json,
        ...(values.filter !== undefined && { filter: values.filter }),
      });
    }

    case 'graph': {
      const format = values.format ?? 'mermaid';
      if (!isGraphFormat(format)) {
        throw new UsageError(`--format must be one of ${GRAPH_FORMATS.join(', ')}, got '${format}'`);
      }
      if (values.offering !== undefined && values.offering.trim() === '') {
        throw new UsageError("--offering needs an offering id — run 'list' to see the catalog");
      }
      return commands.cmdGraph({
        catalogDir,
        scenariosDir: values.scenarios ?? process.env.SCOPEGRAPH_SCENARIOS ?? './scenarios',
        // DATA_DIR as the server resolves it, so `--out` can never land on payment records.
        dataDir: process.env.DATA_DIR?.trim() || './data',
        json,
        format,
        ...(values.offering !== undefined && { offering: values.offering }),
        ...(values.out !== undefined && { out: values.out }),
      });
    }

    case 'serve':
      return commands.cmdServe({
        catalogDir,
        ...(values.port !== undefined && { port: parsePort(values.port) }),
        ...(values.host !== undefined && { host: values.host }),
        ...(values.stdio !== undefined && { stdio: Boolean(values.stdio) }),
        ...(values.watch !== undefined && { watch: Boolean(values.watch) }),
      });

    case 'orders':
      return runOrders(
        positionals.slice(1),
        {
          json: Boolean(values.json),
          ...(values.status !== undefined && { status: values.status }),
          ...(values.reason !== undefined && { reason: values.reason }),
          ...(values.url !== undefined && { url: values.url }),
        },
      );

    case 'mcp-config':
      return runMcpConfig({ catalogDir });

    default:
      process.stderr.write(`error: unknown command '${command}'\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

// Compare real paths: behind a symlinked bin (npm link, global install, npx),
// argv[1] is the link while import.meta.url is the resolved module.
const invokedDirectly =
  process.argv[1] !== undefined
  && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  // The checkout's .env (never the working directory's; rules in ./env-file.ts),
  // for the server, doctor and orders alike — only when run as a program, so
  // tests calling main() never read a developer's .env.
  loadEnvFileInto(join(CHECKOUT_ROOT, '.env'), process.env, (message) => process.stderr.write(`warning: ${message}\n`));
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`error: ${error.message}\n\n${USAGE}`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}
