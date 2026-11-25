/**
 * `scopegraph doctor`: offline checks across env permutations (payments off,
 * half-configured, fully configured, DATA_DIR lock states, currency,
 * PUBLIC_URL schemes) and online checks against an injected fake Stripe
 * client plus a local express /health stub — no real Stripe, no real network.
 */
import type { Server } from 'node:http';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_WEBHOOK_EVENTS } from '../payments/index.js';
import { runDoctor } from './doctor.js';
import type { DoctorFlags, DoctorStripe } from './doctor.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scopegraph-doctor-'));
  tempDirs.push(dir);
  return dir;
}

function makeCatalog(currency = 'USD'): string {
  const root = tmpDir();
  mkdirSync(join(root, 'offerings'), { recursive: true });
  writeFileSync(
    join(root, 'business.yaml'),
    ['name: Test Co', `currency: ${currency}`, 'timezone: UTC'].join('\n'),
  );
  writeFileSync(join(root, 'offerings', 'city-tour.yaml'), 'name: City Tour\ndescription: A guided walk around town.\nprice: 85\n');
  return root;
}

const LONG = 'x'.repeat(40);
function fullEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STRIPE_SECRET_KEY: `sk_test_${LONG}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${LONG}`,
    PUBLIC_URL: 'https://book.example.com',
    ADMIN_TOKEN: LONG,
    ORDER_SIGNING_SECRET: 'y'.repeat(40),
    ...overrides,
  };
}

interface CheckJson {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  summary: string;
  fix?: string;
}

function captureOutput(): () => { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  return () => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    return { stdout, stderr };
  };
}

async function runJson(
  options: DoctorFlags,
): Promise<{ code: number; body: { ok: boolean; payments: string; offline: boolean; checks: CheckJson[] } }> {
  const read = captureOutput();
  const code = await runDoctor({ ...options, json: true });
  const { stdout } = read();
  return { code, body: JSON.parse(stdout) as { ok: boolean; payments: string; offline: boolean; checks: CheckJson[] } };
}

function byId(checks: CheckJson[], id: string): CheckJson {
  const check = checks.find((candidate) => candidate.id === id);
  expect(check, `expected a '${id}' check`).toBeDefined();
  return check!;
}

// ─── Fake Stripe ─────────────────────────────────────────────────────────────

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

interface FakeStripeOptions {
  paymentIntentsStatus?: number;
  webhookStatus?: number;
  endpoints?: Array<{ url: string; enabled_events: string[]; status?: string }>;
}

function fakeStripe(options: FakeStripeOptions = {}): DoctorStripe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    paymentIntents: {
      list: async (params: { limit: number }) => {
        calls.push(`paymentIntents.list:${String(params.limit)}`);
        if (options.paymentIntentsStatus !== undefined) {
          throw httpError(options.paymentIntentsStatus, 'Stripe says no');
        }
        return { data: [] };
      },
    },
    webhookEndpoints: {
      list: async (params: { limit: number }) => {
        calls.push(`webhookEndpoints.list:${String(params.limit)}`);
        if (options.webhookStatus !== undefined) {
          throw httpError(options.webhookStatus, 'Stripe says no');
        }
        return { data: options.endpoints ?? [] };
      },
    },
  };
}

function endpointFor(url: string, events: string[] = [...STRIPE_WEBHOOK_EVENTS]): { url: string; enabled_events: string[] } {
  return { url, enabled_events: events };
}

// ─── Offline checks ──────────────────────────────────────────────────────────

describe('runDoctor offline', () => {
  it('payments off: clean catalog, exit 0, stable JSON shape', async () => {
    const catalog = makeCatalog();
    const { code, body } = await runJson({ catalogDir: catalog, offline: true, env: {} });
    expect(code).toBe(0);
    expect(body).toMatchObject({ ok: true, payments: 'off', offline: true });
    expect(body.checks.map((check) => check.id)).toEqual(['catalog', 'payments']);
    expect(body.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('a broken catalog fails (exit 1) and says how to fix it', async () => {
    const catalog = tmpDir(); // no business.yaml at all
    const { code, body } = await runJson({ catalogDir: catalog, offline: true, env: {} });
    expect(code).toBe(1);
    expect(body.ok).toBe(false);
    const check = byId(body.checks, 'catalog');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('validate');
  });

  it('payments enabled but half-configured: boot rules fail with every missing variable', async () => {
    const catalog = makeCatalog();
    const { code, body } = await runJson({
      catalogDir: catalog,
      offline: true,
      env: { STRIPE_SECRET_KEY: `sk_test_${LONG}` },
    });
    expect(code).toBe(1);
    const boot = byId(body.checks, 'payments_boot');
    expect(boot.status).toBe('fail');
    expect(boot.fix).toContain('STRIPE_WEBHOOK_SECRET');
    expect(boot.fix).toContain('PUBLIC_URL');
    expect(boot.fix).toContain('ADMIN_TOKEN');
    expect(boot.fix).toContain('ORDER_SIGNING_SECRET');
    // Reported once: the boot rules already name PUBLIC_URL, so no separate public_url check.
    expect(body.checks.filter((check) => check.fix?.includes('PUBLIC_URL') === true || check.id === 'public_url').map((check) => check.id)).toEqual(['payments_boot']);
  });

  it('fully configured (offline): exit 0, profile-id warning surfaced, everything else ok', async () => {
    const catalog = makeCatalog();
    const dataDir = tmpDir();
    const { code, body } = await runJson({
      catalogDir: catalog,
      offline: true,
      env: fullEnv({ DATA_DIR: dataDir }),
    });
    expect(code).toBe(0);
    expect(body.payments).toBe('on');
    expect(byId(body.checks, 'payments_boot').status).toBe('ok');
    expect(byId(body.checks, 'payments_warnings').status).toBe('warn');
    expect(byId(body.checks, 'payments_warnings').summary).toContain('STRIPE_PROFILE_ID');
    expect(byId(body.checks, 'payments_warnings').summary).not.toContain('scopegraph:');
    expect(byId(body.checks, 'data_dir').status).toBe('ok');
    expect(byId(body.checks, 'public_url').status).toBe('ok');
    expect(body.checks.some((check) => check.id === 'stripe_key')).toBe(false);
  });

  it('a fresh lock heartbeat warns about a running server (pid included), a stale lock does not', async () => {
    const catalog = makeCatalog();
    const fresh = tmpDir();
    writeFileSync(join(fresh, '.lock'), `${JSON.stringify({ pid: 4242, hostname: 'h', startedAt: 'now', token: 't' })}\n`);
    const freshRun = await runJson({ catalogDir: catalog, offline: true, env: fullEnv({ DATA_DIR: fresh }) });
    expect(freshRun.code).toBe(0); // warn, not fail
    const freshCheck = byId(freshRun.body.checks, 'data_dir');
    expect(freshCheck.status).toBe('warn');
    expect(freshCheck.summary).toContain('appears to be running');
    expect(freshCheck.summary).toContain('pid 4242');

    const stale = tmpDir();
    const lockPath = join(stale, '.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: 9999 })}\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const staleRun = await runJson({ catalogDir: catalog, offline: true, env: fullEnv({ DATA_DIR: stale }) });
    const staleCheck = byId(staleRun.body.checks, 'data_dir');
    expect(staleCheck.status).toBe('ok');
    expect(staleCheck.summary).toContain('stale');
  });

  it('a non-two-decimal catalog currency fails the catalog check with the compiler wording', async () => {
    const catalog = makeCatalog('JPY');
    const read = captureOutput();
    const code = await runDoctor({ catalogDir: catalog, json: true, offline: true, env: fullEnv() });
    const { stdout, stderr } = read();
    const body = JSON.parse(stdout) as { checks: CheckJson[] };
    expect(code).toBe(1);
    expect(byId(body.checks, 'catalog').status).toBe('fail');
    expect(stderr).toContain("UNSUPPORTED_CURRENCY currency 'JPY' is not supported yet: catalog money is compiled to 1/100 units");
    expect(byId(body.checks, 'payments_boot').status).toBe('warn'); // not checked: the catalog did not compile
  });

  it('PUBLIC_URL: https ok, http on localhost warns, plain http elsewhere fails', async () => {
    const catalog = makeCatalog();
    const httpsRun = await runJson({
      catalogDir: catalog,
      offline: true,
      env: fullEnv({ PUBLIC_URL: 'https://book.example.com' }),
    });
    expect(byId(httpsRun.body.checks, 'public_url').status).toBe('ok');

    const localRun = await runJson({
      catalogDir: catalog,
      offline: true,
      env: fullEnv({ PUBLIC_URL: 'http://localhost:3000' }),
    });
    const localCheck = byId(localRun.body.checks, 'public_url');
    expect(localCheck.status).toBe('warn');
    expect(localCheck.summary).toContain('localhost');

    const plainRun = await runJson({
      catalogDir: catalog,
      offline: true,
      env: fullEnv({ PUBLIC_URL: 'http://book.example.com' }),
    });
    expect(byId(plainRun.body.checks, 'payments_boot').fix).toContain('PUBLIC_URL must use https');
    expect(plainRun.body.checks.some((check) => check.id === 'public_url')).toBe(false);
    expect(plainRun.code).toBe(1);
  });

  it('human output uses ✓/⚠/✗ marks with fix lines', async () => {
    const catalog = makeCatalog();
    const read = captureOutput();
    const code = await runDoctor({
      catalogDir: catalog,
      json: false,
      offline: true,
      env: { STRIPE_SECRET_KEY: `sk_test_${LONG}` },
    });
    const { stdout } = read();
    expect(code).toBe(1);
    expect(stdout).toContain('✓');
    expect(stdout).toContain('✗');
    expect(stdout).toContain('fix:');
  });

  it.skipIf(process.platform === 'win32')('creates DATA_DIR private (0700) and warns when an existing one is open to other users', async () => {
    const catalog = makeCatalog();
    const dataDir = join(tmpDir(), 'new-data');
    const created = await runJson({ catalogDir: catalog, offline: true, env: fullEnv({ DATA_DIR: dataDir }) });
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(byId(created.body.checks, 'data_dir_mode')).toMatchObject({ status: 'ok' });

    chmodSync(dataDir, 0o755);
    const open = await runJson({ catalogDir: catalog, offline: true, env: fullEnv({ DATA_DIR: dataDir }) });
    expect(open.code).toBe(0); // a warning, not a failure
    const check = byId(open.body.checks, 'data_dir_mode');
    expect(check.status).toBe('warn');
    expect(check.summary).toContain('mode 0755');
    expect(check.fix).toContain('chmod 700');
  });

  it('fails on TRUST_PROXY=true and warns on EXPOSE_TRACE=true in production and on ALLOWED_ORIGINS=*', async () => {
    const catalog = makeCatalog();
    const trustTrue = await runJson({ catalogDir: catalog, offline: true, env: { TRUST_PROXY: ' True ' } });
    expect(trustTrue.code).toBe(1);
    const trust = byId(trustTrue.body.checks, 'trust_proxy');
    expect(trust.status).toBe('fail');
    expect(trust.summary).toContain('TRUST_PROXY=true');
    expect(trust.fix).toContain('number of proxies');

    const risky = await runJson({
      catalogDir: catalog,
      offline: true,
      env: { NODE_ENV: 'production', EXPOSE_TRACE: 'true', ALLOWED_ORIGINS: 'https://a.example.com, *' },
    });
    expect(risky.code).toBe(0);
    expect(byId(risky.body.checks, 'expose_trace').status).toBe('warn');
    expect(byId(risky.body.checks, 'allowed_origins').status).toBe('warn');

    // The safe forms say nothing: a hop count, a trace outside production, an explicit origin list.
    const fine = await runJson({
      catalogDir: catalog,
      offline: true,
      env: { TRUST_PROXY: '1', EXPOSE_TRACE: 'true', ALLOWED_ORIGINS: 'https://a.example.com' },
    });
    expect(fine.code).toBe(0);
    expect(fine.body.checks.map((check) => check.id)).toEqual(['catalog', 'payments']);
  });
});

// ─── Online checks ───────────────────────────────────────────────────────────

describe('runDoctor online', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    const app = express();
    app.get('/health', (_req, res) => {
      res.json({ ok: true, offerings: 1 });
    });
    server = app.listen(0, '127.0.0.1');
    // tsconfig targets ES2022 (no Promise.withResolvers): executor form it is.
    await new Promise<void>((resolve) => {
      server.once('listening', () => resolve());
    });
    const address = server.address();
    expect(address && typeof address === 'object').toBe(true);
    baseUrl = `http://127.0.0.1:${String((address as { port: number }).port)}`;
  });

  // Only the local /health stub is reachable: no test may touch the real network.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      (input instanceof Request ? input.url : String(input)).startsWith('http://127.0.0.1:')
        ? realFetch(input, init)
        : Promise.reject(new TypeError('fetch failed (network disabled in tests)')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    server.close();
  });

  it('green end to end against the fake Stripe and the local /health stub', async () => {
    const catalog = makeCatalog();
    const dataDir = tmpDir();
    const stripe = fakeStripe({
      endpoints: [endpointFor(`${baseUrl}/webhooks/stripe`)],
    });
    const { code, body } = await runJson({
      catalogDir: catalog,
      offline: false,
      env: fullEnv({ PUBLIC_URL: baseUrl, DATA_DIR: dataDir }),
      stripe,
    });
    expect(code).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.offline).toBe(false);
    expect(byId(body.checks, 'stripe_key').status).toBe('ok');
    expect(byId(body.checks, 'stripe_mode').summary).toContain('test mode');
    expect(byId(body.checks, 'webhook').status).toBe('ok');
    expect(byId(body.checks, 'webhook').summary).toContain(`${baseUrl}/webhooks/stripe`);
    const health = byId(body.checks, 'health');
    expect(health.status).toBe('ok');
    expect(health.summary).toContain('1 offerings');
    expect(stripe.calls).toContain('paymentIntents.list:1');
  });

  it('distinguishes an invalid key (401) from a missing permission (403)', async () => {
    const catalog = makeCatalog();
    const invalid = await runJson({
      catalogDir: catalog,
      env: fullEnv(),
      stripe: fakeStripe({ paymentIntentsStatus: 401 }),
    });
    expect(invalid.code).toBe(1);
    const invalidCheck = byId(invalid.body.checks, 'stripe_key');
    expect(invalidCheck.status).toBe('fail');
    expect(invalidCheck.summary).toContain('rejected');
    expect(invalidCheck.fix).toContain('STRIPE_SECRET_KEY');

    const forbidden = await runJson({
      catalogDir: catalog,
      env: fullEnv(),
      stripe: fakeStripe({ paymentIntentsStatus: 403 }),
    });
    expect(forbidden.code).toBe(1);
    const forbiddenCheck = byId(forbidden.body.checks, 'stripe_key');
    expect(forbiddenCheck.status).toBe('fail');
    expect(forbiddenCheck.summary).toContain('permission');
    expect(forbiddenCheck.fix).toContain('Payment Intents');
  });

  it('a live key warns about live mode', async () => {
    const catalog = makeCatalog();
    const { code, body } = await runJson({
      catalogDir: catalog,
      env: fullEnv({ STRIPE_SECRET_KEY: `sk_live_${LONG}` }),
      stripe: fakeStripe({ endpoints: [endpointFor('https://book.example.com/webhooks/stripe')] }),
    });
    const mode = byId(body.checks, 'stripe_mode');
    expect(mode.status).toBe('warn');
    expect(mode.summary).toContain('LIVE');
    expect(code).toBe(0);
  });

  it('webhook: missing endpoint, missing events and a key that cannot list all fail with instructions', async () => {
    const catalog = makeCatalog();

    const missing = await runJson({
      catalogDir: catalog,
      env: fullEnv(),
      stripe: fakeStripe({ endpoints: [] }),
    });
    const missingCheck = byId(missing.body.checks, 'webhook');
    expect(missing.code).toBe(1);
    expect(missingCheck.status).toBe('fail');
    expect(missingCheck.fix).toContain('https://book.example.com/webhooks/stripe');
    expect(missingCheck.fix).toContain('checkout.session.completed');
    expect(missingCheck.fix).toContain('STRIPE_WEBHOOK_SECRET');

    const partial = await runJson({
      catalogDir: catalog,
      env: fullEnv(),
      stripe: fakeStripe({
        endpoints: [endpointFor('https://book.example.com/webhooks/stripe', ['checkout.session.completed'])],
      }),
    });
    const partialCheck = byId(partial.body.checks, 'webhook');
    expect(partial.code).toBe(1);
    expect(partialCheck.status).toBe('fail');
    expect(partialCheck.summary).toContain('6 of 7');
    expect(partialCheck.fix).toContain('payment_intent.succeeded');

    const noList = await runJson({
      catalogDir: catalog,
      env: fullEnv(),
      stripe: fakeStripe({ webhookStatus: 403 }),
    });
    const noListCheck = byId(noList.body.checks, 'webhook');
    expect(noListCheck.status).toBe('warn');
    expect(noListCheck.fix).toContain('Dashboard');
  });

  it('an unreachable /health is a warning, not a failure', async () => {
    const catalog = makeCatalog();
    const { code, body } = await runJson({
      catalogDir: catalog,
      env: fullEnv({ PUBLIC_URL: 'https://no-such-server.example.invalid' }),
      stripe: fakeStripe({ endpoints: [endpointFor('https://no-such-server.example.invalid/webhooks/stripe')] }),
    });
    const health = byId(body.checks, 'health');
    expect(health.status).toBe('warn');
    expect(health.summary).toContain('no server answered');
    expect(code).toBe(0);
  });

  it('--offline never touches Stripe even with payments fully configured', async () => {
    const catalog = makeCatalog();
    const stripe = fakeStripe({ endpoints: [endpointFor('https://book.example.com/webhooks/stripe')] });
    const { body } = await runJson({
      catalogDir: catalog,
      offline: true,
      env: fullEnv(),
      stripe,
    });
    expect(stripe.calls).toHaveLength(0);
    expect(body.checks.some((check) => check.id === 'stripe_key' || check.id === 'webhook' || check.id === 'health')).toBe(false);
  });
});
