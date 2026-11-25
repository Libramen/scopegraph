/**
 * HTTP surface for one business's scopegraph.
 *
 *   GET  /health                          liveness + offering count
 *   GET  /api/business                    public business info
 *   GET  /api/offerings?q=                listOfferings
 *   GET  /api/offerings/:id               describeOffering or 404
 *   POST /api/offerings/:id/scope         evaluate + qualified hand-off
 *   GET  /.well-known/mcp.json            MCP discovery document
 *   GET  /llms.txt                        agent-facing markdown brief
 *   POST /mcp (+ GET/DELETE)              MCP Streamable HTTP endpoint
 *
 * With `payments` (HTTP only, STRIPE_SECRET_KEY configured) the payments
 * module also mounts POST /webhooks/stripe (raw body, not rate limited),
 * /orders/*, /admin/*, /quotes/*, /api/quotes/*, /ucp/*, /acp/*, /mpp/*;
 * scope results carry a payable quote id and MCP gains the payment tools.
 *
 * Middleware: JSON body limit 32 kb, CORS (ALLOWED_ORIGINS or '*'),
 * per-client fixed-window rate limiting (default 60/min) on every route except
 * /health; paths are matched case-insensitively and without trailing slashes,
 * as express routes them. A client is an IPv4 address or an IPv6 /64. The owner's
 * routes (/orders/:id/approve|reject and /admin) are never limited when they
 * carry a valid ADMIN_TOKEN bearer or signed approval token; without one they
 * use a separate per-client bucket (10× the limit), never the public one. The
 * Stripe webhook has its own bucket (10× the limit; Stripe retries on 429).
 * Behind a reverse proxy set TRUST_PROXY to the proxy hop count (e.g. `1`), or
 * `loopback`/a CIDR list, so limits key on the client IP. `true` would trust the
 * client-controlled left-most X-Forwarded-For entry: it is refused.
 *
 * The graph is read through `getGraph()` on every request, so swapping the
 * graph behind that closure (see `runServe --watch`) hot-reloads the catalog.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIPv4, isIPv6 } from 'node:net';
import express, { type Express, type Request, type Response, type NextFunction, type ErrorRequestHandler } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Graph } from '../graph/types.js';
import { listOfferings, describeOfferingForBuyers } from '../engine/index.js';
import type { PaymentsHandle } from '../payments/index.js';
import { STRIPE_WEBHOOK_PATH } from '../payments/webhooks/index.js';
import { SERVER_VERSION, createScopeMcpServer, mcpTools } from './mcp.js';
import { MAX_OFFERING_QUERY_LENGTH, parseScopeInput, runScope } from './scope.js';

export interface CreateAppOptions {
  /** Returns the current compiled graph (re-read per request). */
  getGraph: () => Graph;
  /** Include engine traces in responses (default false; EXPOSE_TRACE=true). */
  exposeTrace?: boolean;
  /** Allowed CORS origins ('*' allowed). Default: ALLOWED_ORIGINS env, else none. */
  allowedOrigins?: string[];
  /** Requests per minute per IP on rate-limited paths. Default: RATE_LIMIT_PER_MINUTE env, else 60. */
  rateLimitPerMinute?: number;
  /** express `trust proxy` setting. Default: TRUST_PROXY env (unset: not trusted). */
  trustProxy?: boolean | number | string;
  /** Enabled payments module (`setupPayments`); omit to serve scoping only. */
  payments?: PaymentsHandle;
}

const RATE_WINDOW_MS = 60_000;
/** The owner's bucket allows this many times the public per-client limit. */
const OWNER_LIMIT_MULTIPLIER = 10;
/** The Stripe webhook's bucket: generous, since Stripe retries a 429 with backoff. */
const WEBHOOK_LIMIT_MULTIPLIER = 10;
/** Upper bound on a body the MCP adapter/handler would read themselves (JSON is already capped by express.json). */
const MCP_MAX_BODY_BYTES = 32 * 1024;
/** An MCP rejection is logged as one line of at most this many characters. */
const MCP_LOG_MAX_CHARS = 200;

/**
 * Per-key fixed-window counter (60 s windows). Only the current window's
 * counters are kept: when the window rolls, every older counter is dropped at
 * once, so clients seen once never accumulate.
 */
export class FixedWindowLimiter {
  private window = Number.NaN;
  private hits = new Map<string, number>();

  constructor(readonly limit: number) {}

  /** Count one hit for `key`; over the limit, returns the seconds until the window resets. */
  hit(key: string, now: number): number | undefined {
    const window = Math.floor(now / RATE_WINDOW_MS);
    if (window !== this.window) {
      this.window = window;
      this.hits = new Map();
    }
    const count = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, count);
    if (count <= this.limit) return undefined;
    return Math.max(1, Math.ceil((((window + 1) * RATE_WINDOW_MS) - now) / 1000));
  }

  /** Keys counted in the current window. */
  get size(): number {
    return this.hits.size;
  }
}

function envOrigins(): string[] | undefined {
  const raw = process.env['ALLOWED_ORIGINS'];
  if (!raw) return undefined;
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function envRateLimit(): number | undefined {
  const raw = process.env['RATE_LIMIT_PER_MINUTE'];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Shortest prefix a trusted range may have: a broader one trusts client-written X-Forwarded-For like `true`. */
const MIN_TRUSTED_PREFIX_V4 = 8;
const MIN_TRUSTED_PREFIX_V6 = 16;

/**
 * TRUST_PROXY → express `trust proxy`: false, a hop count, or an address/subnet
 * list string. `true` throws: it trusts the left-most X-Forwarded-For entry,
 * which the client writes, so every per-client limit could be dodged. So does a
 * range shorter than /8 (IPv4, including IPv4-mapped IPv6 and dotted netmasks)
 * or /16 (IPv6): a few such ranges cover every client.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value.toLowerCase() === 'true') {
    throw new Error('TRUST_PROXY=true trusts client-written X-Forwarded-For; set the number of proxies in front (e.g. 1)');
  }
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  for (const entry of value.split(',').map((part) => part.trim())) {
    const slash = entry.indexOf('/');
    if (slash < 0) continue;
    const address = entry.slice(0, slash);
    const mask = entry.slice(slash + 1);
    // A dotted netmask (`255.0.0.0`) counts its set bits; proxy-addr rejects non-contiguous ones.
    const bits = isIPv4(mask)
      ? mask.split('.').reduce((sum, octet) => sum + Number(octet).toString(2).replaceAll('0', '').length, 0)
      : Number.parseInt(mask, 10);
    // IPv4-mapped IPv6 (`::ffff:0:0/96`) is stored as IPv4 with 96 bits fewer.
    const v4Bits = isIPv4(address) ? bits : isIPv6(address) && /^::ffff:/i.test(address) ? bits - 96 : undefined;
    const tooBroad = v4Bits !== undefined ? v4Bits < MIN_TRUSTED_PREFIX_V4 : isIPv6(address) && bits < MIN_TRUSTED_PREFIX_V6;
    if (tooBroad) {
      throw new Error(`TRUST_PROXY range ${entry} trusts too many addresses; list your proxy's addresses or use the hop count (e.g. 1)`);
    }
  }
  return value;
}

/**
 * Resolve the public base URL for absolute links (PUBLIC_URL wins, e.g. behind a proxy).
 * Without PUBLIC_URL the URL comes from the request's Host header, so the
 * response is marked `no-store`: a shared cache must never replay one client's Host to others.
 */
function publicBaseUrl(req: Request, res: Response): string {
  const configured = process.env['PUBLIC_URL'];
  if (configured) return configured.replace(/\/+$/, '');
  res.setHeader('Cache-Control', 'no-store');
  const host = req.get('host') ?? `localhost:${String(req.socket.localPort ?? '')}`;
  return `${req.protocol}://${host}`;
}

/**
 * The rate-limit and per-client quota key for an address: IPv4 as is (an
 * IPv4-mapped IPv6 address is unwrapped to its IPv4 form), IPv6 by its /64
 * prefix — one subscriber usually holds a whole /64, so per-address keys
 * would let them rotate through 2^64 fresh buckets.
 */
export function clientBucketKey(address: string): string {
  const ip = address.split('%')[0] ?? address; // drop an IPv6 zone id (`fe80::1%en0`)
  if (!isIPv6(ip)) return ip;
  // An embedded dotted IPv4 tail (`::ffff:1.2.3.4`) becomes two 16-bit groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const hex = v4 === null
    ? ip
    : `${ip.slice(0, v4.index)}${((Number(v4[1]) << 8) | Number(v4[2])).toString(16)}:${((Number(v4[3]) << 8) | Number(v4[4])).toString(16)}`;
  // isIPv6 guarantees at most one `::`; expand it to the missing zero groups.
  const [head = '', tail] = hex.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill('0');
  const words = [...headGroups, ...zeros, ...tailGroups].map((group) => Number.parseInt(group, 16));
  const [w0, w1, w2, w3, w4, w5, w6 = 0, w7 = 0] = words;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return `${String(w6 >> 8)}.${String(w6 & 0xff)}.${String(w7 >> 8)}.${String(w7 & 0xff)}`;
  }
  return `${words.slice(0, 4).map((word) => word.toString(16)).join(':')}::/64`;
}

/** The rate-limit and per-client quota key of a request: its client IP (after `trust proxy`). */
function clientKey(req: Request): string {
  return clientBucketKey(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

/**
 * MCP rejections are mostly client-caused (bad media type, malformed JSON-RPC,
 * oversized body): log one bounded line, never a stack, so request input cannot
 * flood stderr.
 */
function logMcpError(context: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // C0/C1 controls (incl. newlines) collapse to a space: the log line stays one line.
  const line = detail.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, MCP_LOG_MAX_CHARS);
  console.error(`scopegraph: ${context}: ${line}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the express app. One instance serves both the plain HTTP API and the
 * MCP endpoint; pass your own `getGraph` to embed it in a bigger app.
 */
export function createApp(options: CreateAppOptions): Express {
  const { getGraph, payments } = options;
  const exposeTrace = options.exposeTrace === true;
  const allowedOrigins = options.allowedOrigins ?? envOrigins();
  const allowAll = allowedOrigins?.includes('*');
  const originSet = allowAll ? undefined : new Set(allowedOrigins ?? []);
  const limit = options.rateLimitPerMinute ?? envRateLimit() ?? 60;

  const app = express();
  app.disable('x-powered-by');
  const trustProxy = options.trustProxy ?? parseTrustProxy(process.env['TRUST_PROXY']);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Requests without an Origin header (non-browser clients) skip CORS.
  // Browser requests get echoing allow-list semantics, or '*' when configured.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      if (allowAll) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (originSet !== undefined && originSet.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (res.hasHeader('Access-Control-Allow-Origin')) {
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PUT, DELETE, OPTIONS',
        );
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Resume-Id, Last-Event-ID, Authorization, Idempotency-Key, API-Version',
        );
        res.setHeader('Access-Control-Max-Age', '86400');
      }
    }
    if (req.method === 'OPTIONS') {
      // Preflight: 204 with headers above (a disallowed origin gets no
      // Access-Control-Allow-* headers and is blocked by the browser).
      res.status(204).end();
      return;
    }
    next();
  });

  // ── Per-client fixed-window rate limiter: every route but /health ──────────
  // Runs before body parsing so a throttled client costs no parse. Express
  // routes case-insensitively and ignores a trailing slash, so the limiter
  // classifies the same normalized path (`/API/…`, `/mcp/` are `/api/…`, `/mcp`).
  // Three buckets: public traffic, the owner's approval/admin routes, and the
  // Stripe webhook (generous: Stripe retries on 429, so this only caps floods).
  const buckets = {
    public: new FixedWindowLimiter(limit),
    owner: new FixedWindowLimiter(limit * OWNER_LIMIT_MULTIPLIER),
    webhook: new FixedWindowLimiter(limit * WEBHOOK_LIMIT_MULTIPLIER),
  };
  app.use((req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if (path === '/health') {
      next();
      return;
    }
    // Stripe calls the exact configured path; any variant is ordinary traffic.
    const webhook = payments !== undefined && req.path === STRIPE_WEBHOOK_PATH;
    const owner = !webhook && payments?.isOwnerRoute(path) === true;
    if (owner && payments?.hasOwnerCredential({ path, authorization: req.get('authorization'), token: req.query['t'] }) === true) {
      // A real ADMIN_TOKEN or a valid signed approval link: the owner is never rate limited.
      next();
      return;
    }
    const bucket = webhook ? buckets.webhook : owner ? buckets.owner : buckets.public;
    if (bucket.limit <= 0) {
      next();
      return;
    }
    const retryAfterSeconds = bucket.hit(clientKey(req), Date.now());
    if (retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests. Limit is ${String(bucket.limit)} per minute per IP.`,
      });
      return;
    }
    next();
  });

  // The Stripe webhook verifies its signature over the raw body: it parses its own.
  const json = express.json({ limit: '32kb' });
  app.use((req, res, next) => {
    if (payments !== undefined && req.path === STRIPE_WEBHOOK_PATH) {
      next();
      return;
    }
    json(req, res, next);
  });

  // A POST to /api/… that carries a body express.json did not parse (form
  // data, text, no content type): 415, like /mcp, instead of silently
  // treating it as `{}`. A bodyless POST (e.g. payment-link) passes through.
  app.use((req, res, next) => {
    const hasBody = req.headers['transfer-encoding'] !== undefined
      || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    if (req.method === 'POST' && req.path.toLowerCase().startsWith('/api/') && hasBody && req.body === undefined) {
      res.status(415).json({ error: 'unsupported_media_type', message: 'Content-Type must be application/json.' });
      return;
    }
    next();
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const graph = getGraph();
    res.json({ ok: true, offerings: Object.keys(graph.offerings).length });
  });

  // ── Public business info ───────────────────────────────────────────────────
  app.get('/api/business', (_req, res) => {
    const { business } = getGraph();
    res.json({
      name: business.name,
      ...(business.description !== undefined ? { description: business.description } : {}),
      ...(business.website !== undefined ? { website: business.website } : {}),
      currency: business.currency,
      timezone: business.timezone,
    });
  });

  // ── Offerings ──────────────────────────────────────────────────────────────
  app.get('/api/offerings', (req, res) => {
    const raw = req.query['q'];
    if (typeof raw === 'string' && raw.length > MAX_OFFERING_QUERY_LENGTH) {
      res.status(400).json({
        error: 'invalid_request',
        message: `\`q\` must be at most ${String(MAX_OFFERING_QUERY_LENGTH)} characters.`,
      });
      return;
    }
    const q = typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
    res.json({ offerings: listOfferings(getGraph(), q) });
  });

  app.get('/api/offerings/:id', (req, res) => {
    const description = describeOfferingForBuyers(getGraph(), req.params['id'] ?? '');
    if (!description) {
      res.status(404).json({
        error: 'not_found',
        message: `Offering '${req.params['id'] ?? ''}' not found.`,
      });
      return;
    }
    res.json(description);
  });

  // ── Scope (the main entry point) ───────────────────────────────────────────
  app.post('/api/offerings/:id/scope', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    void (async () => {
      const offering = req.params.id;
      const parsed = parseScopeInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: 'invalid_request', message: parsed.message });
        return;
      }
      // 200 for every evaluate outcome (unavailable/invalid/needs_input/
      // blocked/qualified); the body's `status` field carries the outcome.
      const result = await runScope(getGraph(), offering, parsed.input, exposeTrace, payments?.scope, clientKey(req));
      res.status(200).json(result);
    })().catch(next);
  });

  // ── Agent discovery ────────────────────────────────────────────────────────
  app.get('/.well-known/mcp.json', (req, res) => {
    const { business } = getGraph();
    res.json({
      name: business.name,
      version: SERVER_VERSION,
      ...(business.description !== undefined ? { description: business.description } : {}),
      transport: 'streamable-http',
      url: `${publicBaseUrl(req, res)}/mcp`,
      tools: mcpTools(payments).map((t) => ({ name: t.name, description: t.description })),
    });
  });

  app.get('/llms.txt', (req, res) => {
    const graph = getGraph();
    const { business } = graph;
    const base = publicBaseUrl(req, res);
    const lines: string[] = [
      `# ${business.name}`,
      '',
      business.description?.trim() ?? `Offerings from ${business.name}.`,
      '',
      ...(business.website !== undefined ? [`Website: ${business.website}`, ''] : []),
      `Currency: ${business.currency}`,
      `Timezone: ${business.timezone} (dates, notice periods and date-based prices use this local time)`,
      '',
      '## Offerings',
      '',
    ];
    for (const summary of listOfferings(graph)) {
      const bits = [`- **${summary.name}** (\`${summary.id}\`)`];
      // One bullet per offering: folded/literal YAML descriptions carry newlines.
      if (summary.description !== undefined) bits.push(`— ${summary.description.trim().replace(/\s*\n\s*/g, ' ')}`);
      if (summary.priceFrom !== undefined) bits.push(`From ${summary.priceFrom}.`);
      lines.push(bits.join(' '));
    }
    lines.push(
      '',
      '## MCP',
      '',
      `Connect an MCP client (Streamable HTTP) to ${base}/mcp. Discovery: ${base}/.well-known/mcp.json.`,
      `Tools: ${mcpTools(payments).map((t) => t.name).join(', ')}.`,
      'Workflow: list offerings, then call scope_offering for the one you want with the buyer\'s answers (it asks one question at a time).',
      'On needs_input, ask the buyer the question and call again with ALL accumulated answers/selections/date;',
      'on qualified, present the quote (money is integer minor units, currency given), offer any relevant `addOns` (re-scope with them in selections) and the `next` hand-off.',
      ...(payments !== undefined
        ? ['Payments: a payable qualified quote has `quote.id` (qt_…); `next.checkout` lists how to pay it (UCP checkout with a Stripe shared payment token, or a payment link for a human).']
        : []),
      '',
      '## HTTP API',
      '',
      `- GET ${base}/api/business — public business info`,
      `- GET ${base}/api/offerings?q= — list (optional filter)`,
      `- GET ${base}/api/offerings/:id — full description`,
      `- POST ${base}/api/offerings/:id/scope — body {"answers": {...}, "selections": {...}, "date": "..."};`,
      '  the outcome (unavailable, invalid, needs_input, blocked or qualified, as in the MCP tool) is in the `status` field.',
      '  Every scoping outcome is HTTP 200; a malformed request gets 400 (bad JSON or shape), 413 (body over 32 kb) or 415 (not application/json).',
      `- GET ${base}/health — liveness`,
      '',
    );
    res.type('text/plain; charset=utf-8').send(lines.join('\n'));
  });

  // ── MCP Streamable HTTP ────────────────────────────────────────────────────
  // Stateless serving: a fresh server instance is created per request from the
  // factory, so no session state is held and the current graph is always used.
  // The factory reads the request's client key (per-client quote quota) from
  // this async context: the SDK builds the instance inside the request's chain.
  const mcpClient = new AsyncLocalStorage<string>();
  const mcpHandler = createMcpHandler(
    () => createScopeMcpServer(getGraph, exposeTrace, payments, mcpClient.getStore()),
    {
      maxRequestBodySize: MCP_MAX_BODY_BYTES,
      onerror: (err) => {
        logMcpError('MCP request rejected', err);
      },
    },
  );
  const mcpNodeHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
    onerror: (err) => {
      logMcpError('MCP adapter error', err);
    },
  });
  // POST carries requests (express.json already parsed the body — it is passed
  // through so the stream is never re-read); GET/DELETE are session operations
  // the SDK answers (stateless mode: 405), reading at most MCP_MAX_BODY_BYTES.
  app.all('/mcp', (req, res) => {
    if (req.method === 'POST' && req.body === undefined) {
      // Not parsed as JSON (text/plain, no content type, …): the SDK would buffer
      // the raw stream into memory. Refuse before reading a byte (node discards
      // the unread upload without buffering it).
      res.status(415).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unsupported Media Type: Content-Type must be application/json' },
        id: null,
      });
      return;
    }
    const parsedBody = isPlainObject(req.body) || req.body === undefined ? req.body : {};
    mcpClient.run(clientKey(req), () => mcpNodeHandler(req, res, parsedBody)).catch((err: unknown) => {
      logMcpError('MCP request failed', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', message: 'MCP request failed.' });
      }
    });
  });
  // For runServe's graceful shutdown.
  app.locals.mcpClose = (): Promise<void> => mcpHandler.close();

  // ── Payments (webhook, owner approval, admin, doors) ───────────────────────
  payments?.mount(app);

  // ── Unknown routes: JSON 404, never express's HTML page ───────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint. See /llms.txt.' });
  });

  // ── Errors: always JSON, never an HTML stack page ─────────────────────────
  // Covers body-parser rejections (malformed JSON → 400, > 32 kb → 413) and
  // any handler throw (→ 500, logged server-side, no internals leaked).
  app.use(((err, _req, res, _next) => {
    const status = err instanceof SyntaxError
      || (typeof err.status === 'number' && err.status >= 400 && err.status < 500)
      ? err.status ?? 400
      : 500;
    if (status >= 500) {
      console.error('scopegraph: request failed:', err);
      res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
    } else {
      res.status(status).json({
        error: 'invalid_request',
        message: 'Request body is malformed or too large.',
      });
    }
  }) as ErrorRequestHandler);

  return app;
}
