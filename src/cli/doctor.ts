/**
 * `scopegraph doctor` — pre-flight checklist for a scopegraph deployment.
 *
 * Local checks: the catalog compiles (errors/warnings counts — an
 * unsupported currency is a compile error); server settings that are
 * refused or risky (TRUST_PROXY=true — the server's own parser, reused —
 * EXPOSE_TRACE=true under NODE_ENV=production, ALLOWED_ORIGINS=*; reported
 * only when present); payments configured or off;
 * when on, every boot rule from `loadPaymentsConfig` (reused, never
 * duplicated), DATA_DIR writability (created 0700) + its permissions + lock
 * state (a fresh lock heartbeat means a server is running — a warning, not a
 * failure), PUBLIC_URL scheme
 * (unless the boot rules already reported it). Online checks (skipped with --offline):
 * the Stripe key works (`paymentIntents.list`, invalid key distinguished
 * from missing permission), test vs live mode, a webhook endpoint for
 * PUBLIC_URL/webhooks/stripe subscribed to `STRIPE_WEBHOOK_EVENTS`, and
 * PUBLIC_URL/health reachable (5s timeout).
 *
 * Human output is ✓/⚠/✗ with an indented `fix:` line for every ⚠/✗;
 * --json prints `{ ok, catalogDir, payments, offline, checks: [{ id,
 * status: 'ok'|'warn'|'fail', summary, fix? }] }`. Exit codes: 0 ok (warnings
 * allowed), 1 any ✗.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formatDiagnostic, loadGraph } from '../compile/index.js';
import type { Diagnostic } from '../compile/diagnostics.js';
import type { Graph } from '../graph/types.js';
import { loadPaymentsConfig } from '../payments/config.js';
import { STRIPE_WEBHOOK_EVENTS, STRIPE_WEBHOOK_PATH } from '../payments/webhooks/index.js';
import type { PaymentsConfig } from '../payments/types.js';
import { colorEnabled, createStyle } from './format.js';
import type { Style } from './format.js';

/** The Stripe surface doctor uses; the SDK client satisfies it structurally. */
export interface DoctorStripe {
  paymentIntents: { list(params: { limit: number }): Promise<unknown> };
  webhookEndpoints: {
    list(params: { limit: number }): Promise<{
      data: Array<{ url: string; enabled_events: string[]; status?: string }>;
    }>;
  };
}

/** Flags parsed by the CLI entry point (also the test seam for them). */
export interface DoctorFlags {
  catalogDir: string;
  json?: boolean;
  offline?: boolean;
  /** Environment to read (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Stripe client for the online checks (defaults to the real SDK). */
  stripe?: DoctorStripe;
}

type CheckStatus = 'ok' | 'warn' | 'fail';

interface Check {
  id: string;
  status: CheckStatus;
  summary: string;
  fix?: string;
}

/** Shape of `loadGraph`'s result (compile module contract). */
interface CatalogLoadResult {
  graph?: Graph;
  diagnostics: Diagnostic[];
}

const out = (text = '') => process.stdout.write(`${text}\n`);
const err = (text = '') => process.stderr.write(`${text}\n`);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** HTTP status embedded in a thrown Stripe SDK error, if any. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return undefined;
}

/**
 * A lock left by a stopped server is taken over automatically once its
 * heartbeat is this old — the store's default stale window
 * (src/payments/store/store.ts). Only used for the display judgment here;
 * lock behaviour itself lives entirely in the store.
 */
const STALE_LOCK_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
/** Loopback host names where plain http is acceptable (PUBLIC_URL here, `orders --url`). */
export const LISTENING_LOCAL_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };

// ─── Local checks ────────────────────────────────────────────────────────────

function catalogCheck(loaded: CatalogLoadResult, catalogDir: string): Check {
  const errors = loaded.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = loaded.diagnostics.length - errors;
  if (loaded.graph === undefined || errors > 0) {
    return {
      id: 'catalog',
      status: 'fail',
      summary: `catalog has ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
      fix: "run 'npm run sg -- validate' and fix every error first (diagnostics below)",
    };
  }
  if (warnings > 0) {
    return {
      id: 'catalog',
      status: 'warn',
      summary: `catalog compiles with ${warnings} warning${warnings === 1 ? '' : 's'}`,
      fix: "run 'npm run sg -- validate' — warnings usually mean a rule or price can never fire",
    };
  }
  return { id: 'catalog', status: 'ok', summary: `catalog compiles clean (0 errors, 0 warnings) in ${catalogDir}` };
}

async function dataDirCheck(dataDir: string): Promise<Check> {
  try {
    // Private from the start: payments.json holds buyer contact details.
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const probe = join(dataDir, '.doctor-probe');
    await writeFile(probe, `${Date.now()}\n`);
    await rm(probe, { force: true });
  } catch (error) {
    return {
      id: 'data_dir',
      status: 'fail',
      summary: `DATA_DIR ${dataDir} is not writable (${messageOf(error)})`,
      fix: 'point DATA_DIR (in .env) at a writable directory on a persistent volume — payments.json lives there',
    };
  }
  let lockStat;
  try {
    lockStat = await stat(join(dataDir, '.lock'));
  } catch {
    return { id: 'data_dir', status: 'ok', summary: `DATA_DIR ${dataDir} writable; no lock — no server is using it` };
  }
  const ageMs = Date.now() - lockStat.mtimeMs;
  if (ageMs <= STALE_LOCK_MS) {
    let pid = '';
    try {
      const lock: unknown = JSON.parse(await readFile(join(dataDir, '.lock'), 'utf8'));
      if (typeof lock === 'object' && lock !== null && 'pid' in lock && typeof lock.pid === 'number') {
        pid = `, pid ${String(lock.pid)}`;
      }
    } catch {
      // Best-effort decoration only.
    }
    return {
      id: 'data_dir',
      status: 'warn',
      summary: `DATA_DIR ${dataDir} writable; its lock heartbeat is ${String(Math.max(0, Math.round(ageMs / 1000)))}s old${pid} — a scopegraph server appears to be running`,
      fix: 'run one server per DATA_DIR: stop the other server or point its DATA_DIR elsewhere (docs/payments.md)',
    };
  }
  return {
    id: 'data_dir',
    status: 'ok',
    summary: `DATA_DIR ${dataDir} writable; its lock is stale (${String(Math.round(ageMs / 1000))}s old) — the next server start takes it over`,
  };
}

/**
 * DATA_DIR must not be readable or writable by other users: listing reveals
 * order activity, and write access lets them replace payments.json. Files
 * the store writes are 0600 either way. Not judged on Windows (no POSIX modes).
 */
async function dataDirModeCheck(dataDir: string): Promise<Check | undefined> {
  if (process.platform === 'win32') return undefined;
  const mode = (await stat(dataDir)).mode & 0o777;
  const octal = mode.toString(8).padStart(4, '0');
  if ((mode & 0o066) !== 0) {
    return {
      id: 'data_dir_mode',
      status: 'warn',
      summary: `DATA_DIR ${dataDir} is readable or writable by other users (mode ${octal})`,
      fix: `chmod 700 ${dataDir} — it holds buyer contact details and order state`,
    };
  }
  return { id: 'data_dir_mode', status: 'ok', summary: `DATA_DIR ${dataDir} is private to its owner (mode ${octal})` };
}

/**
 * Server settings the server refuses or that weaken a deployment. Only
 * problems are reported: an unset setting is the safe default.
 */
async function serverSettingsChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const trustProxy = env.TRUST_PROXY?.trim();
  if (trustProxy !== undefined && trustProxy !== '') {
    // The server's own parser decides what boots. Imported lazily, like `serve`
    // does: a static import would load express and the MCP SDK into every CLI command.
    const { parseTrustProxy } = await import('../server/app.js');
    try {
      parseTrustProxy(trustProxy);
    } catch (error) {
      checks.push({
        id: 'trust_proxy',
        status: 'fail',
        summary: messageOf(error),
        fix: 'set TRUST_PROXY to the number of proxies in front of the server (usually 1), or unset it when nothing proxies (docs/deploy.md)',
      });
    }
  }
  if (env.EXPOSE_TRACE === 'true' && env.NODE_ENV === 'production') {
    checks.push({
      id: 'expose_trace',
      status: 'warn',
      summary: 'EXPOSE_TRACE=true with NODE_ENV=production — every scope response carries the engine trace (rule ids, conditions, unanswered parameters)',
      fix: 'unset EXPOSE_TRACE: the trace is for debugging and shows buyers your business logic',
    });
  }
  const origins = env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()) ?? [];
  if (origins.includes('*')) {
    checks.push({
      id: 'allowed_origins',
      status: 'warn',
      summary: 'ALLOWED_ORIGINS=* — scripts on any website can call this API from a visitor\'s browser',
      fix: 'list only the browser origins that need the API, comma-separated (e.g. https://your-site.example.com), or unset it',
    });
  }
  return checks;
}

/**
 * PUBLIC_URL aspect for humans. The authoritative rule (https, or http on
 * localhost only) is `loadPaymentsConfig`'s — this only renders the state.
 */
function publicUrlCheck(publicUrl: string | undefined): Check {
  if (publicUrl === undefined || publicUrl === '') {
    return {
      id: 'public_url',
      status: 'fail',
      summary: 'PUBLIC_URL is not set',
      fix: 'set PUBLIC_URL in .env to the https base URL buyers and Stripe reach this server at (e.g. https://book.example.com)',
    };
  }
  let url: URL | undefined;
  try {
    url = new URL(publicUrl);
  } catch {
    return { id: 'public_url', status: 'fail', summary: `PUBLIC_URL is not a valid URL: ${publicUrl}`, fix: 'set PUBLIC_URL to an absolute URL, e.g. https://book.example.com' };
  }
  if (url.protocol === 'https:') {
    return { id: 'public_url', status: 'ok', summary: `PUBLIC_URL ${publicUrl} — https` };
  }
  if (LISTENING_LOCAL_HOSTS[url.hostname] === true) {
    return {
      id: 'public_url',
      status: 'warn',
      summary: `PUBLIC_URL ${publicUrl} — http on localhost, fine for local development only`,
      fix: 'production PUBLIC_URL must use https: Stripe webhooks and buyers must reach the server over https',
    };
  }
  return {
    id: 'public_url',
    status: 'fail',
    summary: `PUBLIC_URL ${publicUrl} — plain http outside localhost`,
    fix: 'PUBLIC_URL must use https (plain http is only allowed for localhost)',
  };
}

// ─── Online checks ───────────────────────────────────────────────────────────

async function stripeKeyCheck(client: DoctorStripe): Promise<Check> {
  try {
    await client.paymentIntents.list({ limit: 1 });
    return { id: 'stripe_key', status: 'ok', summary: 'Stripe key works (paymentIntents.list)' };
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 401) {
      return {
        id: 'stripe_key',
        status: 'fail',
        summary: `Stripe rejected the key: ${messageOf(error)}`,
        fix: 'check STRIPE_SECRET_KEY in .env — a secret or restricted key from the Stripe Dashboard (sk_test_…, rk_test_…)',
      };
    }
    if (status === 403) {
      return {
        id: 'stripe_key',
        status: 'fail',
        summary: `the key lacks permission: ${messageOf(error)}`,
        fix: "give the restricted key 'Payment Intents write' (docs/payments.md § Stripe setup)",
      };
    }
    return {
      id: 'stripe_key',
      status: 'warn',
      summary: `could not verify the key (${messageOf(error)})`,
      fix: 'check network and Stripe status, then rerun; --offline skips this check',
    };
  }
}

function stripeModeCheck(secretKey: string): Check {
  const mode = /^(?:sk|rk)_(test|live)_/.exec(secretKey)?.[1];
  if (mode === 'live') {
    return {
      id: 'stripe_mode',
      status: 'warn',
      summary: 'Stripe key is LIVE mode — real charges will move',
      fix: 'while setting up, use a test key (sk_test_… / rk_test_…); switch to live deliberately',
    };
  }
  if (mode === 'test') {
    return { id: 'stripe_mode', status: 'ok', summary: 'Stripe key is test mode — safe to experiment' };
  }
  return {
    id: 'stripe_mode',
    status: 'warn',
    summary: 'Stripe key prefix is not a recognized secret/restricted key',
    fix: 'STRIPE_SECRET_KEY must start sk_test_ / sk_live_ / rk_test_ / rk_live_',
  };
}

function webhookEventsList(): string {
  return STRIPE_WEBHOOK_EVENTS.map((event) => `- ${event}`).join('\n');
}

async function webhookCheck(client: DoctorStripe, publicUrl: string | undefined): Promise<Check> {
  if (publicUrl === undefined || publicUrl === '') {
    return {
      id: 'webhook',
      status: 'warn',
      summary: 'webhook endpoint not checked — PUBLIC_URL is not usable',
      fix: 'fix PUBLIC_URL first; the endpoint lives at PUBLIC_URL/webhooks/stripe',
    };
  }
  const expected = `${publicUrl.replace(/\/+$/, '')}${STRIPE_WEBHOOK_PATH}`;
  let endpoints: Array<{ url: string; enabled_events: string[]; status?: string }>;
  try {
    endpoints = (await client.webhookEndpoints.list({ limit: 100 })).data;
  } catch (error) {
    const status = httpStatusOf(error);
    const manual = `check the Stripe Dashboard (Developers → Webhooks): ${expected} must exist and be subscribed to:\n${webhookEventsList()}`;
    if (status === 403) {
      return {
        id: 'webhook',
        status: 'warn',
        summary: 'the restricted key cannot list webhook endpoints',
        fix: manual,
      };
    }
    return {
      id: 'webhook',
      status: 'warn',
      summary: `could not list webhook endpoints (${messageOf(error)})`,
      fix: manual,
    };
  }
  const match = endpoints.find((endpoint) => endpoint.url.replace(/\/+$/, '') === expected);
  if (match === undefined) {
    return {
      id: 'webhook',
      status: 'fail',
      summary: `no webhook endpoint registered for ${expected}`,
      fix: `Stripe Dashboard → Developers → Webhooks → Add endpoint: ${expected}, subscribed to:\n${webhookEventsList()}\nthen copy its signing secret (whsec_…) to STRIPE_WEBHOOK_SECRET`,
    };
  }
  if (match.status === 'disabled') {
    return {
      id: 'webhook',
      status: 'fail',
      summary: `webhook endpoint ${expected} is disabled`,
      fix: 're-enable the endpoint in the Stripe Dashboard',
    };
  }
  const missing = STRIPE_WEBHOOK_EVENTS.filter((event) => !match.enabled_events.includes(event));
  if (missing.length > 0) {
    return {
      id: 'webhook',
      status: 'fail',
      summary: `webhook endpoint ${expected} is missing ${String(missing.length)} of ${String(STRIPE_WEBHOOK_EVENTS.length)} required events: ${missing.join(', ')}`,
      fix: `edit the endpoint in the Stripe Dashboard and add:\n${missing.map((event) => `- ${event}`).join('\n')}`,
    };
  }
  return {
    id: 'webhook',
    status: 'ok',
    summary: `webhook endpoint ${expected} subscribed to all ${String(STRIPE_WEBHOOK_EVENTS.length)} required events`,
  };
}

async function healthCheck(publicUrl: string | undefined): Promise<Check> {
  if (publicUrl === undefined || publicUrl === '') {
    return {
      id: 'health',
      status: 'warn',
      summary: 'health not checked — PUBLIC_URL is not usable',
      fix: 'fix PUBLIC_URL first; the health endpoint lives at PUBLIC_URL/health',
    };
  }
  const url = `${publicUrl.replace(/\/+$/, '')}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        id: 'health',
        status: 'warn',
        summary: `${url} answered HTTP ${String(response.status)}`,
        fix: 'check the server logs and any reverse proxy in front of it',
      };
    }
    let offerings = '';
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'offerings' in body && typeof body.offerings === 'number') {
        offerings = ` — ${String(body.offerings)} offerings`;
      }
    } catch {
      // Body shape is decoration only.
    }
    return { id: 'health', status: 'ok', summary: `${url} reachable${offerings}` };
  } catch (error) {
    return {
      id: 'health',
      status: 'warn',
      summary: `no server answered at ${url} (${messageOf(error)})`,
      fix: 'start one (npm run dev locally, docs/deploy.md in production) and rerun — doctor checks configuration first, liveness second',
    };
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

function printHuman(checks: Check[], payments: 'on' | 'off', offline: boolean, style: Style): void {
  out(style.dim(`catalog checks (payments ${payments}${offline ? ', online checks skipped (--offline)' : ''})`));
  for (const check of checks) {
    const colored =
      check.status === 'ok' ? style.green(MARK.ok) : check.status === 'warn' ? style.yellow(MARK.warn) : style.red(MARK.fail);
    out(`${colored} ${check.summary}`);
    if (check.fix !== undefined) {
      for (const line of check.fix.split('\n')) out(`  fix: ${line}`);
    }
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export async function runDoctor(flags: DoctorFlags): Promise<number> {
  const env = flags.env ?? process.env;
  const json = flags.json === true;
  const offline = flags.offline === true;
  const checks: Check[] = [];
  const online: Check[] = [];

  let graph: Graph | undefined;
  let diagnostics: Diagnostic[] = [];
  try {
    const loaded = await loadGraph(flags.catalogDir);
    graph = loaded.graph;
    diagnostics = loaded.diagnostics;
    checks.push(catalogCheck(loaded, flags.catalogDir));
  } catch (error) {
    checks.push({
      id: 'catalog',
      status: 'fail',
      summary: `catalog cannot be loaded from '${flags.catalogDir}': ${messageOf(error)}`,
      fix: "run 'npm run sg -- init' to scaffold one, or pass --catalog <dir>",
    });
  }
  if (checks[0]?.status === 'fail') {
    for (const diagnostic of diagnostics) err(formatDiagnostic(diagnostic));
  }
  checks.push(...(await serverSettingsChecks(env)));

  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  let paymentsConfig: PaymentsConfig | undefined;
  let payments: 'on' | 'off';

  if (secretKey === undefined || secretKey === '') {
    payments = 'off';
    checks.push({
      id: 'payments',
      status: 'ok',
      summary: 'payments off — STRIPE_SECRET_KEY is not set (quoting only; no payment doors mounted)',
    });
  } else {
    payments = 'on';
    const warns: string[] = [];
    let bootProblems: string[] = [];
    if (graph === undefined) {
      checks.push({
        id: 'payments_boot',
        status: 'warn',
        summary: 'payments boot rules not checked — the catalog did not compile',
        fix: 'fix the catalog first (see the diagnostics above)',
      });
    } else {
      const result = loadPaymentsConfig(env, graph.business, (message) => warns.push(message));
      if (result === undefined) {
        // Unreachable with a non-empty key (loadPaymentsConfig returns
        // undefined only when STRIPE_SECRET_KEY is unset), but the contract
        // allows it — report it rather than guess.
        checks.push({ id: 'payments_boot', status: 'warn', summary: 'loadPaymentsConfig reported payments off despite a set key' });
      } else if ('error' in result) {
        bootProblems = result.error
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('- '))
          .map((line) => line.slice(2));
        checks.push({
          id: 'payments_boot',
          status: 'fail',
          summary: `payments are enabled but misconfigured (${String(bootProblems.length)} problem${bootProblems.length === 1 ? '' : 's'})`,
          fix: `${bootProblems.map((problem) => `- ${problem}`).join('\n')}\n- see docs/payments.md § Stripe setup`,
        });
      } else {
        paymentsConfig = result;
        checks.push({
          id: 'payments_boot',
          status: 'ok',
          summary: `payments boot configuration valid (confirmation: ${result.confirmation})`,
        });
      }
    }
    if (warns.length > 0) {
      checks.push({
        id: 'payments_warnings',
        status: 'warn',
        summary: warns.join(' · '),
        fix: 'optional: STRIPE_PROFILE_ID enables the agent-token doors (UCP/ACP/MPP); see docs/payments.md',
      });
    }
    const dataDir = paymentsConfig?.dataDir ?? resolve(env.DATA_DIR?.trim() || './data');
    const dataDirResult = await dataDirCheck(dataDir);
    checks.push(dataDirResult);
    if (dataDirResult.status !== 'fail') {
      const modeCheck = await dataDirModeCheck(dataDir);
      if (modeCheck !== undefined) checks.push(modeCheck);
    }

    const publicUrl = paymentsConfig?.publicUrl ?? env.PUBLIC_URL?.trim() ?? undefined;
    // A PUBLIC_URL problem is already listed under payments_boot; don't report it twice.
    if (!bootProblems.some((problem) => problem.startsWith('PUBLIC_URL'))) checks.push(publicUrlCheck(publicUrl));

    if (!offline) {
      // Loaded only for the online checks: the Stripe SDK has import-time side
      // effects (stderr output in some hosts) that every other command must not pay.
      const client = flags.stripe ?? new (await import('stripe')).default(secretKey, { maxNetworkRetries: 2 });
      online.push(await stripeKeyCheck(client));
      online.push(stripeModeCheck(secretKey));
      online.push(await webhookCheck(client, publicUrl));
      online.push(await healthCheck(publicUrl));
    }
  }

  const all = [...checks, ...online];
  const failed = all.some((check) => check.status === 'fail');

  if (json) {
    out(
      JSON.stringify(
        {
          ok: !failed,
          catalogDir: flags.catalogDir,
          payments,
          offline,
          checks: all.map((check) => ({
            id: check.id,
            status: check.status,
            summary: check.summary,
            ...(check.fix !== undefined ? { fix: check.fix } : {}),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    const style = createStyle(colorEnabled());
    printHuman(all, payments, offline, style);
    if (all.every((check) => check.status === 'ok')) {
      out(style.green('✓ everything checks out'));
    }
  }
  return failed ? 1 : 0;
}

