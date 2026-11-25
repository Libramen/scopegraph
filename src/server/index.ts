/**
 * `scopegraph serve` — load a catalog, serve it.
 *
 *   runServe({ catalogDir: 'catalog' })                 HTTP on :3000
 *   runServe({ catalogDir: 'catalog', watch: true })    hot-reload catalog edits
 *   runServe({ catalogDir: 'catalog', stdio: true })    MCP over stdio (local agents)
 *
 * Environment:
 *   PORT                   listen port (default 3000)
 *   HOST                   bind address (default 0.0.0.0)
 *   ALLOWED_ORIGINS        CORS allow-list, comma-separated, or '*'
 *   RATE_LIMIT_PER_MINUTE  requests/min per client (IPv4 address or IPv6 /64) on every route but
 *                          /health (default 60); owner routes and the Stripe webhook get 10×
 *   EXPOSE_TRACE           'true' to include engine traces in responses (boot warns
 *                          loudly under NODE_ENV=production)
 *   PUBLIC_URL             absolute base URL for links (proxies/LLM discovery); unset,
 *                          discovery docs echo the Host header (sent no-store, boot warns)
 *   TRUST_PROXY            express `trust proxy` behind a reverse proxy: the hop count
 *                          (e.g. 1), loopback or a CIDR list — `true` is refused (spoofable)
 *   STRIPE_SECRET_KEY      enables payments (HTTP mode only; see docs/payments.md
 *                          for STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN, ORDER_SIGNING_SECRET,
 *                          DATA_DIR, STRIPE_PROFILE_ID, ACP_*, MPP_ENABLED)
 *
 * Misconfigured payments, TRUST_PROXY=true (or a DATA_DIR locked by another process) exit 1.
 * Errors in the catalog print formatted diagnostics and exit 1; warnings
 * print but the server starts anyway. With --watch, a failed reload keeps
 * serving the last good graph; with payments enabled, so does a reload that
 * changes `business.currency` or `business.payments` (restart to apply those).
 */
import * as fs from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Diagnostic } from '../compile/diagnostics.js';
import { loadGraph, formatDiagnostic } from '../compile/index.js';
import { loadPaymentsConfig, paymentsReloadConflict, setupPayments } from '../payments/index.js';
import type { PaymentsHandle } from '../payments/index.js';
import { createScopeMcpServer } from './mcp.js';
import { createApp, parseTrustProxy } from './app.js';
import type { CreateAppOptions } from './app.js';
export type { CreateAppOptions } from './app.js';

export interface ServeOptions {
  /** Directory containing the catalog YAML files. */
  catalogDir: string;
  /** Listen port (default: PORT env or 3000). */
  port?: number;
  /** Bind address (default: HOST env or '0.0.0.0'). */
  host?: string;
  /** Serve MCP over stdio instead of HTTP (for local agent configs). */
  stdio?: boolean;
  /** Recompile the catalog on file changes and hot-swap the graph. */
  watch?: boolean;
}

function printDiagnostics(diagnostics: Diagnostic[], warn: (s: string) => void): void {
  for (const d of diagnostics) {
    warn(formatDiagnostic(d));
  }
}

/**
 * `--watch` reload serializer: each call starts a load, and only the newest
 * call's outcome is handled — a slower earlier reload never overwrites (or
 * reports over) the graph of a newer one.
 */
export function newestReloadWins<T>(
  load: () => Promise<T>,
  onLoaded: (value: T) => void,
  onFailed: (err: unknown) => void,
): () => Promise<void> {
  let generation = 0;
  return () => {
    const mine = ++generation;
    return load()
      .then((value) => {
        if (mine === generation) onLoaded(value);
      })
      .catch((err: unknown) => {
        if (mine === generation) onFailed(err);
      });
  };
}

/**
 * The boot warning for `EXPOSE_TRACE=true` under `NODE_ENV=production`, or
 * undefined. Traces name rules, conditions and unanswered parameters: in
 * production that hands buyers the business logic progressive disclosure hides.
 */
export function exposeTraceWarning(env: NodeJS.ProcessEnv): string | undefined {
  if (env['EXPOSE_TRACE'] !== 'true' || env['NODE_ENV'] !== 'production') return undefined;
  return 'scopegraph: WARNING: EXPOSE_TRACE=true with NODE_ENV=production. Every scope response carries the engine trace '
    + '(rule ids, conditions, unanswered parameters), which shows buyers your business logic. Unset EXPOSE_TRACE unless you are debugging.';
}

/**
 * Start the server. Resolves when shutdown completes (HTTP mode resolves only
 * on SIGTERM/SIGINT; stdio mode blocks for the life of the connection).
 */
export async function runServe(options: ServeOptions): Promise<void> {
  const { catalogDir } = options;
  const exposeTrace = process.env['EXPOSE_TRACE'] === 'true';
  const traceWarning = exposeTraceWarning(process.env);
  if (traceWarning !== undefined) console.error(traceWarning);
  // In stdio mode stdout is the protocol channel — all logs go to stderr.
  const log = (message: string) => {
    if (options.stdio === true) console.error(message);
    else console.log(message);
  };

  const initial = await loadGraph(catalogDir);
  const errors = initial.diagnostics.filter((d) => d.severity === 'error');
  printDiagnostics(errors, console.error);
  printDiagnostics(
    initial.diagnostics.filter((d) => d.severity !== 'error'),
    console.warn,
  );
  if (!initial.graph || errors.length > 0) {
    // Fatal catalog: nothing to serve, nothing to drain — exit now so the
    // process exit status is 1 even if a caller awaits runServe.
    process.exit(1);
  }

  let current = initial.graph;
  const bootBusiness = initial.graph.business;
  const getGraph = () => current;

  // ── stdio mode ──────────────────────────────────────────────────────────────
  if (options.stdio === true) {
    log(`scopegraph: serving ${Object.keys(current.offerings).length} offering(s) over stdio`);
    if (process.env['STRIPE_SECRET_KEY'] !== undefined && process.env['STRIPE_SECRET_KEY'] !== '') {
      // Payments need webhooks, the reconciler and one writer per DATA_DIR: HTTP only.
      console.error('scopegraph: payments are not available in stdio mode (scoping tools only); serve over HTTP to take payments');
    }
    const handle = serveStdio(() => createScopeMcpServer(getGraph, exposeTrace), {
      onerror: (err) => {
        console.error('scopegraph stdio error:', err);
      },
    });
    const shutdown = (signal: string) => {
      log(`scopegraph: ${signal}, closing stdio connection`);
      void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // Serve until the client disconnects (stdin closes) or a signal arrives.
    await new Promise<void>(() => {});
    return;
  }

  // ── HTTP mode ───────────────────────────────────────────────────────────────
  let trustProxy: CreateAppOptions['trustProxy'];
  try {
    trustProxy = parseTrustProxy(process.env['TRUST_PROXY']);
  } catch (err) {
    console.error(`scopegraph: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let payments: PaymentsHandle | undefined;
  const paymentsConfig = loadPaymentsConfig(process.env, current.business);
  if (paymentsConfig !== undefined && 'error' in paymentsConfig) {
    console.error(`scopegraph: ${paymentsConfig.error}`);
    process.exit(1);
  }
  if (paymentsConfig !== undefined) {
    try {
      payments = await setupPayments({ getGraph, config: paymentsConfig });
    } catch (err) {
      console.error(`scopegraph: payments failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const app = createApp({
    getGraph,
    exposeTrace,
    ...(trustProxy !== undefined ? { trustProxy } : {}),
    ...(payments !== undefined ? { payments } : {}),
  });
  const port = options.port
    ?? (Number.parseInt(process.env['PORT'] ?? '', 10) || undefined)
    ?? 3000;
  const host = options.host ?? process.env['HOST'] ?? '0.0.0.0';

  const server = app.listen(port, host, () => {
    log(
      `scopegraph: serving ${String(Object.keys(current.offerings).length)} offering(s) `
        + `for "${current.business.name}" on http://${host}:${String(port)} `
        + `(MCP: /mcp, HTTP API: /api, health: /health)`,
    );
    if (options.watch === true) {
      log(`scopegraph: watching ${catalogDir} for changes`);
    }
    if (payments !== undefined) {
      payments.start();
      log(
        `scopegraph: payments enabled (${payments.config.stripe.livemode ? 'LIVE' : 'test'} mode, `
          + `${payments.config.confirmation}, data in ${payments.config.dataDir})`,
      );
    }
    if (!process.env['PUBLIC_URL']) {
      console.warn(
        'scopegraph: PUBLIC_URL is not set — /.well-known/mcp.json and /llms.txt build links from the request Host header '
          + '(sent Cache-Control: no-store). Set PUBLIC_URL to your public https URL in production.',
      );
    }
  });
  server.on('error', (err) => {
    console.error(`scopegraph: failed to listen on ${host}:${String(port)}:`, err);
    process.exit(1);
  });

  let watcher: fs.FSWatcher | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  if (options.watch === true) {
    const reload = newestReloadWins(
      () => loadGraph(catalogDir),
      ({ graph, diagnostics }) => {
        const errors = diagnostics.filter((d) => d.severity === 'error');
        if (!graph || errors.length > 0) {
          printDiagnostics(diagnostics, (s) => console.error(s));
          console.error('scopegraph: reload failed — keeping the previous catalog');
          return;
        }
        const warnings = diagnostics.filter((d) => d.severity !== 'error');
        printDiagnostics(warnings, (s) => console.warn(s));
        const conflict = payments !== undefined ? paymentsReloadConflict(bootBusiness, graph.business) : undefined;
        if (conflict !== undefined) {
          console.error(`scopegraph: reload refused — ${conflict}. Keeping the previous catalog; restart the server to apply.`);
          return;
        }
        current = graph;
        log(`scopegraph: reloaded ${String(Object.keys(current.offerings).length)} offering(s)`);
      },
      (err) => {
        console.error('scopegraph: reload failed — keeping the previous catalog:', err);
      },
    );
    try {
      watcher = fs.watch(catalogDir, { recursive: true }, () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = undefined;
          void reload();
        }, 200);
      });
    } catch (err) {
      console.error(`scopegraph: cannot watch ${catalogDir}:`, err);
    }
  }

  // tsconfig targets ES2022 (no Promise.withResolvers): executor form it is.
  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log(`scopegraph: ${signal}, shutting down`);
      // An open fs.watch handle (or a pending reload) keeps the event loop alive.
      watcher?.close();
      clearTimeout(reloadTimer);
      const mcpClose = app.locals.mcpClose as (() => Promise<void>) | undefined;
      // Stop the sweep, drain hooks, flush the store and release the DATA_DIR lock.
      const closeAll = () => Promise.allSettled([mcpClose?.(), payments?.stop()]);
      server.close(() => {
        void closeAll().finally(() => resolve());
      });
      // Hard stop if connections refuse to drain.
      setTimeout(() => {
        void closeAll().finally(() => process.exit(0));
      }, 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
}
