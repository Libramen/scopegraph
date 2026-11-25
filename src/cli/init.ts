/**
 * `scopegraph init` — scaffold a fresh starter catalog.
 *
 * Replaces `catalog/` and `scenarios/` in the target directory with a small,
 * fully commented business: `business.yaml` (name, currency, timezone,
 * optional tax rate, payments block only when payments are on), one example
 * offering (`example-service`: a required question, an optional priced
 * choice, a block rule, a pricing adjustment) and its three scenarios
 * (needs_input, blocked, qualified with an exact total). Each file starts
 * with a `yaml-language-server` modeline pointing at the JSON Schema in this
 * package's schema/ directory (relative to the file), for editor checking.
 *
 * Interactive when stdin is a TTY (prompts for every flag not passed, via
 * node:readline); `--yes` takes the defaults (My Business, USD, UTC,
 * payments off) so agents can run it non-interactively. Refuses to overwrite
 * a non-empty catalog/ or scenarios/ unless `--force` (or an interactive
 * confirm). After writing, the starter is verified: it must validate with
 * zero errors and warnings and its scenarios must pass. Exit codes: 0 ok,
 * 1 refused/failed, 2 usage error.
 */
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { formatDiagnostic, loadGraph } from '../compile/index.js';
import type { Diagnostic } from '../compile/diagnostics.js';
import type { Graph } from '../graph/types.js';
import { runScenarioFiles } from '../scenarios/run.js';
import { schemaModeline } from '../catalog/schema-files.js';
import { isTwoDecimalCurrency, unsupportedCurrencyMessage } from '../pricing/currency.js';
import { colorEnabled, createStyle } from './format.js';

/** Shape of `loadGraph`'s result (compile module contract). */
interface CatalogLoadResult {
  graph?: Graph;
  diagnostics: Diagnostic[];
}

const INIT_USAGE = `Usage:
  scopegraph init [--dir <dir>] [--name <n>] [--currency <ISO>]
                  [--timezone <tz>] [--tax-rate <pct>]
                  [--payments off|owner_approves|instant] [--force] [--yes]

Writes a fresh starter catalog/ and scenarios/ into --dir (default '.'):
one commented example offering and its scenarios, ready to edit. Prompts
for anything not passed when attached to a terminal; --yes accepts the
defaults (My Business, USD, UTC, no tax, payments off) instead, so scripts
and agents can run it non-interactively. A non-empty catalog/ or scenarios/
is only replaced with --force (or an interactive confirm).`;

/** Flags parsed by the CLI entry point (also the test seam for them). */
export interface InitFlags {
  dir?: string;
  name?: string;
  currency?: string;
  timezone?: string;
  /** Percent, e.g. "8.5"; parsed here so misuse is a usage error. */
  taxRate?: string;
  payments?: string;
  force?: boolean;
  yes?: boolean;
}

/** Payments setting for the generated business.yaml. */
export type PaymentsMode = 'off' | 'owner_approves' | 'instant';

/** Everything the templates need, after flags + prompts are resolved. */
interface Resolved {
  name: string;
  currency: string;
  timezone: string;
  taxRate?: number;
  payments: PaymentsMode;
}

/** Terminal (or test) seam: prompts only happen through this. */
export interface InitIo {
  /** True when a human can be asked (stdin is a TTY). */
  readonly interactive: boolean;
  /** Ask one question; returns the trimmed answer (empty = keep default). */
  ask(question: string): Promise<string>;
  /** Ask a yes/no question. */
  confirm(question: string): Promise<boolean>;
}

const out = (text = '') => process.stdout.write(`${text}\n`);
const err = (text = '') => process.stderr.write(`${text}\n`);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Defaults per --yes / empty prompt answers. */
const DEFAULT_NAME = 'My Business';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_TIMEZONE = 'UTC';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Up to 4 decimals: the catalog stores tax in millionths (e.g. 8.25% → 82,500). */
const TAX_RATE_PATTERN = /^\d+(?:\.\d{1,4})?$/;
const PAYMENTS_MODES: Record<string, true> = { off: true, owner_approves: true, instant: true };
/** Base + rush subtotal of the generated example, in cents. */
const STARTER_SUBTOTAL_CENTS = 13_500;

function validateCurrency(raw: string): string | undefined {
  const currency = raw.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    return `currency must be a 3-letter ISO 4217 code (e.g. USD), got '${raw}'`;
  }
  if (!isTwoDecimalCurrency(currency)) return unsupportedCurrencyMessage(currency);
  return undefined;
}

function validateTimezone(raw: string): string | undefined {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw.trim() });
  } catch {
    return `timezone must be an IANA zone name (e.g. America/New_York), got '${raw}'`;
  }
  return undefined;
}

function parseTaxRate(raw: string): { rate?: number; error?: string } {
  if (!TAX_RATE_PATTERN.test(raw)) {
    return { error: `tax rate must be a percent like 8.5 or 8.875 (at most 4 decimals), got '${raw}'` };
  }
  const rate = Number(raw);
  if (rate < 0 || rate > 100) {
    return { error: `tax rate must be between 0 and 100, got '${raw}'` };
  }
  return { rate };
}

/**
 * True unless `path` is absent or an empty real directory: a file, a symlink
 * (even to an empty dir) or an unreadable path all count as existing, so the
 * replace-guard never lets `rm` clobber them without --force.
 */
async function hasEntries(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return !stats.isDirectory() || (await readdir(path)).length > 0;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Expected tax for the qualified scenario, in cents — the same arithmetic
 * the engine performs: percent → millionths (compiler), that rate of the taxable
 * subtotal rounded half away from zero (pricing).
 */
function expectedTaxCents(subtotalCents: number, taxRatePercent: number): number {
  const micros = Math.round(taxRatePercent * 10_000);
  return Math.floor((subtotalCents * micros) / 1_000_000 + 0.5);
}

function businessYaml(resolved: Resolved): string {
  const lines = [
    '# Business-wide settings — they apply to every offering in catalog/.',
    '# Format reference: docs/catalog-format.md',
    `name: ${JSON.stringify(resolved.name)}`,
    `currency: ${resolved.currency}`,
    `timezone: ${JSON.stringify(resolved.timezone)}`,
    '',
  ];
  if (resolved.taxRate !== undefined) {
    lines.push(
      '# Sales tax added to taxable quote lines (percent, 0-100).',
      `taxRate: ${String(resolved.taxRate)}`,
      '',
    );
  } else {
    lines.push(
      '# Sales tax added to taxable quote lines (percent, 0-100); delete if n/a.',
      '# taxRate: 8.5',
      '',
    );
  }
  lines.push(
    '# What buyer agents see before scoping: by default an overview of each',
    '# offering, then one question at a time (progressive).',
    '# disclosure: menu   # publish every question and add-on up front (default: progressive)',
    '',
  );
  if (resolved.payments === 'off') {
    lines.push(
      '# Payments are off. To take payment for quotes, add a payments block and',
      '# set the Stripe variables in .env — see docs/payments.md:',
      '# payments:',
      '#   confirmation: owner_approves   # hold the card until you approve',
    );
  } else {
    lines.push(
      '# Payment behaviour (the server also needs Stripe env vars — see',
      '# docs/payments.md and .env.example). confirmation: owner_approves',
      '# holds the buyer card until you approve the order; instant charges it',
      '# as soon as the buyer pays.',
      'payments:',
      `  confirmation: ${resolved.payments}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const OFFERING_YAML = `# One offering per file; the file name (example-service) is the id agents
# use to buy it. This starter shows every building block in miniature: a
# question (ask), a choice (choose), a refusal (rules) and a price
# adjustment (pricing). Rename the file, make it yours, and update
# scenarios/example-service.yaml to say what YOUR business would answer.
kind: product
name: Example Service
description: >
  A two-hour session for groups of up to 12, with optional rush handling.
  Replace this description, the price and the rules with your real offering.
category: Services
keywords: [example]

# The buyer must give a date — the weekend surcharge below keys off it.
date: required

# Base price per person: \`per\` names the ask parameter carrying the count.
price:
  amount: 40
  per: people

# Questions for the buyer, asked in the order written.
ask:
  people:
    type: integer
    label: How many people?
    min: 1
    max: 20
    role: quantity # the count the per-person price multiplies by

# Optional add-ons: buyers may select these while scoping; nothing forces
# the question (see the rush-handling scenario).
choose:
  extras:
    label: Extras
    mode: single
    options:
      rush:
        label: Rush handling
        price: 15 # flat add-on charge when selected

# What you refuse. Each rule states the limit and blocks when it is not met,
# so an unanswered question gets asked rather than refused.
rules:
  - id: too_big
    when: { not: { people: { lte: 12 } } }
    block: We can take at most 12 people per booking

# Price adjustments the buyer did not choose: when-gated quote lines.
pricing:
  - id: weekend_surcharge
    label: Weekend surcharge
    kind: surcharge
    percent: 10
    basis: base # 10% of the session price, not of add-ons
    when: { isWeekend: true }
    reason: Weekend sessions cost a little more
`;

function scenariosYaml(resolved: Resolved): string {
  const taxCents =
    resolved.taxRate === undefined ? 0 : expectedTaxCents(STARTER_SUBTOTAL_CENTS, resolved.taxRate);
  const totalCents = STARTER_SUBTOTAL_CENTS + taxCents;
  const total = totalCents / 100;
  const taxComment =
    resolved.taxRate === undefined
      ? '# 40 x 3 + 15 rush'
      : `# 40 x 3 + 15 rush + tax at ${String(resolved.taxRate)}%`;
  const taxLines = resolved.taxRate === undefined ? [] : [`      tax: ${String(taxCents / 100)}`];
  return `# Scenarios are executable specs: each runs one request through the engine
# and asserts the outcome — they prove the catalog says what the business
# means. Write them in the buyer's words and keep them green:
#   npm run scenarios
defaults:
  now: '2026-01-01T00:00:00Z'
scenarios:
  # 1. Nothing answered yet: the engine asks for a date first.
  - name: asks for a date first
    offering: example-service
    expect:
      status: needs_input
      asks: date

  # 2. A request you would refuse: more than 12 people.
  - name: more than 12 people is refused
    offering: example-service
    date: '2026-01-07'
    answers: { people: 15 }
    expect:
      status: blocked
      rule: too_big

  # 3. The happy path, priced exactly (always assert the total).
  - name: three people with rush handling qualify
    offering: example-service
    date: '2026-01-07' # a Wednesday — no weekend surcharge
    answers: { people: 3 }
    selections: { extras: rush }
    expect:
      status: qualified
      total: ${String(total)} ${taxComment}
      lines:
        - { label: Example Service, amount: 120 }
        - { label: Rush handling, amount: 15 }
${taxLines.join('\n')}
`.replace(/\n{3,}/g, '\n\n');
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

async function askWithDefault(
  io: InitIo,
  question: string,
  fallback: string,
  validate: (value: string) => string | undefined,
): Promise<string> {
  for (;;) {
    const answer = await io.ask(`${question} [${fallback}]: `);
    const value = answer === '' ? fallback : answer;
    const problem = validate(value);
    if (problem === undefined) return value;
    err(problem);
  }
}

async function askOptionalTaxRate(io: InitIo): Promise<number | undefined> {
  for (;;) {
    const answer = await io.ask('Sales tax percent (e.g. 8.5), empty for none []: ');
    if (answer === '') return undefined;
    const parsed = parseTaxRate(answer);
    if (parsed.error !== undefined) {
      err(parsed.error);
      continue;
    }
    return parsed.rate;
  }
}

/** Ask for every value the flags did not carry (interactive only). */
async function promptForMissing(flags: InitFlags, io: InitIo): Promise<Resolved> {
  const name =
    flags.name !== undefined && flags.name !== ''
      ? flags.name
      : await askWithDefault(io, 'Business name', DEFAULT_NAME, (value) =>
          value === '' ? 'the business needs a name' : undefined,
        );
  const currency =
    flags.currency !== undefined
      ? flags.currency
      : await askWithDefault(io, 'Currency (ISO 4217)', DEFAULT_CURRENCY, validateCurrency);
  const timezone =
    flags.timezone !== undefined
      ? flags.timezone
      : await askWithDefault(io, 'Timezone (IANA)', DEFAULT_TIMEZONE, validateTimezone);
  const taxRate =
    flags.taxRate !== undefined ? parseTaxRate(flags.taxRate).rate : await askOptionalTaxRate(io);
  const payments =
    flags.payments !== undefined
      ? flags.payments
      : await askWithDefault(io, 'Payments (off | owner_approves | instant)', 'off', (value) =>
          PAYMENTS_MODES[value] === true ? undefined : `payments must be one of off, owner_approves, instant, got '${value}'`,
        );
  return {
    name,
    currency: currency.trim().toUpperCase(),
    timezone: timezone.trim(),
    ...(taxRate !== undefined ? { taxRate } : {}),
    payments: payments as PaymentsMode,
  };
}

/** Defaults for everything the flags did not carry (--yes, non-interactive). */
function defaultsForMissing(flags: InitFlags): Resolved {
  const tax = flags.taxRate !== undefined ? parseTaxRate(flags.taxRate).rate : undefined;
  return {
    name: flags.name !== undefined && flags.name !== '' ? flags.name : DEFAULT_NAME,
    currency: (flags.currency ?? DEFAULT_CURRENCY).trim().toUpperCase(),
    timezone: (flags.timezone ?? DEFAULT_TIMEZONE).trim(),
    ...(tax !== undefined ? { taxRate: tax } : {}),
    payments: (flags.payments ?? 'off') as PaymentsMode,
  };
}

// ─── Command ─────────────────────────────────────────────────────────────────

/** The real terminal IO: node:readline over stdin/stdout, TTY-gated. */
function terminalIo(): InitIo {
  const askOnce = async (question: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  return {
    interactive: Boolean(process.stdin.isTTY),
    ask: async (question) => (await askOnce(question)).trim(),
    confirm: async (question) => {
      const answer = (await askOnce(`${question} [y/N]: `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    },
  };
}

export async function runInit(flags: InitFlags, io: InitIo = terminalIo()): Promise<number> {
  // Flag values are validated however they arrived (flag, prompt or default).
  if (flags.name !== undefined && (flags.name.trim() === '' || flags.name.trim().length > 200)) {
    err('error: --name must be 1-200 characters\n\n' + INIT_USAGE);
    return 2;
  }
  if (flags.currency !== undefined) {
    const problem = validateCurrency(flags.currency);
    if (problem !== undefined) {
      err(`error: ${problem}\n\n${INIT_USAGE}`);
      return 2;
    }
  }
  if (flags.timezone !== undefined) {
    const problem = validateTimezone(flags.timezone);
    if (problem !== undefined) {
      err(`error: ${problem}\n\n${INIT_USAGE}`);
      return 2;
    }
  }
  if (flags.taxRate !== undefined) {
    const { error } = parseTaxRate(flags.taxRate);
    if (error !== undefined) {
      err(`error: ${error}\n\n${INIT_USAGE}`);
      return 2;
    }
  }
  if (flags.payments !== undefined && PAYMENTS_MODES[flags.payments] !== true) {
    err(`error: payments must be one of off, owner_approves, instant, got '${flags.payments}'\n\n${INIT_USAGE}`);
    return 2;
  }

  const missing = [
    flags.name === undefined && 'name',
    flags.currency === undefined && 'currency',
    flags.timezone === undefined && 'timezone',
    flags.taxRate === undefined && 'tax-rate',
    flags.payments === undefined && 'payments',
  ].filter((entry): entry is string => entry !== false);

  if (!io.interactive && missing.length > 0 && flags.yes !== true) {
    err(
      `error: init is not attached to a terminal and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set — `
        + 'pass them as flags, or --yes to accept the defaults\n\n' + INIT_USAGE,
    );
    return 2;
  }

  // --yes accepts defaults even on a terminal; overwrite consent stays with
  // --force / the explicit confirm below.
  const resolved = io.interactive && flags.yes !== true ? await promptForMissing(flags, io) : defaultsForMissing(flags);

  const dir = flags.dir ?? '.';
  const catalogDir = join(dir, 'catalog');
  const scenariosDir = join(dir, 'scenarios');

  // Replace-guard: never silently clobber existing files.
  const existing = (await hasEntries(catalogDir)) || (await hasEntries(scenariosDir));
  if (existing && flags.force !== true) {
    if (io.interactive) {
      const confirmed = await io.confirm(
        `${dir} already has a catalog/ or scenarios/ with files. Replace both with the fresh starter?`,
      );
      if (!confirmed) {
        out('aborted — nothing was written');
        return 1;
      }
    } else {
      err(
        `error: refusing to overwrite the non-empty catalog in '${dir}' — move it aside, or pass --force to replace catalog/ and scenarios/`,
      );
      return 1;
    }
  }

  try {
    await rm(catalogDir, { recursive: true, force: true });
    await rm(scenariosDir, { recursive: true, force: true });
    await mkdir(join(catalogDir, 'offerings'), { recursive: true });
    await mkdir(scenariosDir, { recursive: true });
    const businessFile = join(catalogDir, 'business.yaml');
    const offeringFile = join(catalogDir, 'offerings', 'example-service.yaml');
    const scenariosFile = join(scenariosDir, 'example-service.yaml');
    await writeFile(businessFile, `${schemaModeline(businessFile, 'business')}\n${businessYaml(resolved)}`);
    await writeFile(offeringFile, `${schemaModeline(offeringFile, 'offering')}\n${OFFERING_YAML}`);
    await writeFile(scenariosFile, `${schemaModeline(scenariosFile, 'scenarios')}\n${scenariosYaml(resolved)}`);
  } catch (error) {
    err(`error: could not write the starter to '${dir}': ${messageOf(error)}`);
    return 1;
  }

  // Self-check: the starter we just wrote must be clean and green, whatever
  // flags produced it (the qualified scenario's total depends on the tax rate).
  const style = createStyle(colorEnabled());
  out(style.green(`✓ starter written to ${dir}`));
  out('  catalog/business.yaml');
  out('  catalog/offerings/example-service.yaml');
  out('  scenarios/example-service.yaml');

  let loaded: CatalogLoadResult;
  try {
    loaded = await loadGraph(catalogDir);
  } catch (error) {
    err(`error: the generated catalog could not be loaded: ${messageOf(error)}`);
    return 1;
  }
  const errors = loaded.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = loaded.diagnostics.length - errors;
  if (loaded.graph === undefined || errors > 0 || warnings > 0) {
    for (const diagnostic of loaded.diagnostics) err(formatDiagnostic(diagnostic));
    err(style.red('✗ the generated catalog does not validate clean — this is a bug, please report it'));
    return 1;
  }
  out(style.green('✓ validates clean (0 errors, 0 warnings)'));

  const report = await runScenarioFiles(loaded.graph, [join(scenariosDir, 'example-service.yaml')]);
  if (!report.ok) {
    for (const file of report.files) {
      for (const result of file.results) {
        if (!result.ok && !result.skipped) {
          err(`  ${style.red('✗')} ${result.name}`);
          for (const mismatch of result.mismatches) err(`      ${mismatch}`);
        }
      }
    }
    err(style.red('✗ the generated scenarios fail — this is a bug, please report it'));
    return 1;
  }
  out(style.green(`✓ scenarios pass (${report.passed} passed, ${report.failed} failed)`));

  out('');
  out('Next steps:');
  out('  1. model your business in catalog/ — edit the YAML, or point your coding');
  out('     agent at AGENTS.md (it documents the format and the workflow)');
  out('  2. npm run validate                                   check the catalog');
  out('  3. npm run scenarios                                  run the specs');
  out('  4. npm run simulate -- example-service --interactive  walk the question flow');
  out('  5. npm run dev                                        serve HTTP + MCP locally');
  if (resolved.payments !== 'off') {
    out('  6. cp .env.example .env   then fill in the Stripe variables (docs/payments.md)');
    out('  7. npm run sg -- doctor   verify the payments setup end to end');
  }
  return 0;
}
