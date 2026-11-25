/**
 * `scopegraph orders` — owner-side management of payment orders.
 *
 * Talks to the admin API (docs/payments.md § Approving from the terminal; bearer `ADMIN_TOKEN`):
 *   GET  /admin/orders?status=     → `{ orders: Order[] }` (newest first)
 *   GET  /admin/orders/:id         → `{ order: Order }`
 *   POST /admin/orders/:id/approve → `{ order: Order }` (body ignored)
 *   POST /admin/orders/:id/reject  body `{ reason? }` → `{ order: Order }`
 *
 * Human output is plain text (ANSI only on a TTY with NO_COLOR unset); every
 * server-supplied string is printed with C0/C1 control characters escaped
 * (`\x1b`), so buyer-controlled text cannot drive the owner's terminal.
 * `--json` prints the server's response body verbatim (pretty-printed; JSON
 * already escapes controls) so scripts rely on the same shapes as the HTTP
 * API. `--url` must be https unless it is loopback (the bearer token rides on
 * every request), and redirects are refused. Exit codes: 0 ok,
 * 1 request failed (unreachable server, unauthorized, bad response),
 * 2 usage error.
 */
import { formatMoney } from '../pricing/index.js';
import { IS_TERMINAL } from '../payments/types.js';
import type { Order, OrderStatus } from '../payments/types.js';
import { isId } from '../payments/store/ids.js';
import { LISTENING_LOCAL_HOSTS } from './doctor.js';
import { colorEnabled, createStyle, formatQuote, formatValue } from './format.js';
import type { Style } from './format.js';

const ORDERS_USAGE = `Usage:
  scopegraph orders list [--status <status>]    List orders, newest first
  scopegraph orders show <id>                  Show one order in full
  scopegraph orders approve <id>               Approve a held payment (captures it)
  scopegraph orders reject <id> [--reason <r>] Reject and release a held payment

Options:
  --url <base>    Server base URL (default http://localhost:$PORT, PORT default 3000);
                  https required unless the host is localhost, 127.0.0.1 or [::1]
  --status <s>    list: only orders in this status (e.g. awaiting_approval)
  --reason <r>    reject: why (stored on the order, ≤ 500 chars)
  --json          Print the server's JSON response verbatim
  -h, --help      Show this help

Authentication: the bearer token comes from ADMIN_TOKEN in the environment
(see docs/payments.md).`;

/** Flags parsed by the CLI entry point (also the test seam for them). */
export interface OrdersFlags {
  json?: boolean;
  status?: string;
  reason?: string;
  url?: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(Object.keys(IS_TERMINAL));

/** One-line status hint for the owner, shown next to non-terminal statuses. */
const STATUS_HINT: Partial<Record<OrderStatus, string>> = {
  awaiting_payment: 'buyer has not paid yet (hosted page still open)',
  authorizing: 'authorization in flight — retry shortly',
  awaiting_approval: 'YOU must approve or reject this order',
  capturing: 'capture in flight — retry shortly if it stays here',
  voiding: 'release in flight — retry shortly if it stays here',
};

interface AdminErrorBody {
  error: string;
  message: string;
}

interface CallOptions {
  baseUrl: string;
  token: string;
  json: boolean;
}

/** Result of one admin API call: parsed body, or an error already printed. */
type CallOutcome = { ok: true; body: Record<string, unknown> } | { ok: false; code: number };

/**
 * Run the `orders` command. `positionals` excludes the leading `orders`
 * word: `['list', '--status', 'paid']`. Never throws for misuse or failed
 * requests — prints and returns the exit code.
 */
export async function runOrders(
  positionals: string[],
  flags: OrdersFlags,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const sub = positionals[0];
  const id = positionals[1];
  if (sub === undefined) {
    process.stderr.write(`error: orders needs a subcommand — list, show, approve or reject\n\n${ORDERS_USAGE}\n`);
    return 2;
  }
  if (sub !== 'list' && sub !== 'show' && sub !== 'approve' && sub !== 'reject') {
    process.stderr.write(`error: unknown orders subcommand '${sub}'\n\n${ORDERS_USAGE}\n`);
    return 2;
  }
  if (id !== undefined && !isId('ord', id)) {
    process.stderr.write(
      `error: '${escapeControls(id)}' is not an order id (ord_ + 24 base32 characters, see 'scopegraph orders list')\n`,
    );
    return 2;
  }
  if (sub !== 'list' && id === undefined) {
    process.stderr.write(
      `error: orders ${sub} needs an order id (ord_…, see 'scopegraph orders list')\n\n${ORDERS_USAGE}\n`,
    );
    return 2;
  }
  if (flags.status !== undefined && !VALID_STATUSES.has(flags.status)) {
    const known = [...VALID_STATUSES].sort().join(', ');
    process.stderr.write(`error: unknown status '${flags.status}' — one of: ${known}\n`);
    return 2;
  }
  const token = env.ADMIN_TOKEN;
  if (token === undefined || token === '') {
    process.stderr.write('error: ADMIN_TOKEN is not set — the admin API requires it (see docs/payments.md)\n');
    return 1;
  }
  const baseUrl = (flags.url ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, '');
  const urlProblem = baseUrlProblem(baseUrl);
  if (urlProblem !== undefined) {
    process.stderr.write(`error: --url ${escapeControls(baseUrl)} ${urlProblem}\n`);
    return 2;
  }

  if (sub === 'list') {
    const path = flags.status !== undefined ? `/admin/orders?status=${encodeURIComponent(flags.status)}` : '/admin/orders';
    return requestAndPrint('GET', path, { baseUrl, token, json: flags.json === true }, (body) => {
      if (!Array.isArray(body.orders)) {
        process.stderr.write("error: unexpected response (no 'orders' list)\n");
        return 1;
      }
      printOrderList(body.orders as Order[], flags.status);
      return 0;
    });
  }
  if (sub === 'show') {
    return requestAndPrint('GET', `/admin/orders/${id}`, { baseUrl, token, json: flags.json === true }, (body) => {
      if (!isOrder(body.order)) {
        process.stderr.write(`error: unexpected response from ${baseUrl}/admin/orders/${id} (no 'order')\n`);
        return 1;
      }
      printOrder(body.order);
      return 0;
    });
  }
  // approve / reject: POST, then print the resulting order.
  const path = sub === 'approve' ? `/admin/orders/${id}/approve` : `/admin/orders/${id}/reject`;
  const payload = sub === 'reject' && flags.reason !== undefined ? { reason: flags.reason } : undefined;
  return requestAndPrint(
    'POST',
    path,
    { baseUrl, token, json: flags.json === true },
    (body) => {
      if (!isOrder(body.order)) {
        process.stderr.write(`error: unexpected response from ${baseUrl}${path} (no 'order')\n`);
        return 1;
      }
      printActionResult(body.order);
      return 0;
    },
    payload,
  );
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function callAdmin(
  method: string,
  path: string,
  payload: Record<string, unknown> | undefined,
  options: CallOptions,
): Promise<CallOutcome> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(payload !== undefined && { 'content-type': 'application/json' }),
      },
      ...(payload !== undefined && { body: JSON.stringify(payload) }),
      // Never replay the bearer token to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `error: cannot reach the server at ${options.baseUrl} (${escapeControls(cause)}) — is it running? See docs/deploy.md\n`,
    );
    return { ok: false, code: 1 };
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = 'http_error';
    try {
      const parsed = (await response.json()) as Partial<AdminErrorBody>;
      if (parsed.message !== undefined) message = parsed.message;
      if (parsed.error !== undefined) code = parsed.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    if (response.status === 401) {
      process.stderr.write(`error: ${escapeControls(message)} — check ADMIN_TOKEN (docs/payments.md)\n`);
    } else {
      process.stderr.write(`error: ${escapeControls(message)} (${escapeControls(code)})\n`);
    }
    return { ok: false, code: 1 };
  }
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return { ok: true, body };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${options.baseUrl}${path} returned non-JSON (${escapeControls(cause)})\n`);
    return { ok: false, code: 1 };
  }
}

async function requestAndPrint(
  method: string,
  path: string,
  options: CallOptions,
  print: (body: Record<string, unknown>) => number,
  payload?: Record<string, unknown>,
): Promise<number> {
  const outcome = await callAdmin(method, path, payload, options);
  if (!outcome.ok) return outcome.code;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome.body, null, 2)}\n`);
    return 0;
  }
  // An object stays an object: escaping only rewrites strings and keys.
  return print(escapeControls(outcome.body) as Record<string, unknown>);
}

function isOrder(value: unknown): value is Order {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Order).id === 'string' &&
    typeof (value as Order).status === 'string'
  );
}

// ─── Human output ────────────────────────────────────────────────────────────

const COLUMN_TITLES = {
  id: 'ID',
  status: 'STATUS',
  door: 'DOOR',
  offering: 'OFFERING',
  total: 'TOTAL',
  buyer: 'BUYER',
  created: 'CREATED',
} as const;

function printOrderList(orders: Order[], statusFilter: string | undefined): void {
  if (orders.length === 0) {
    const scope = statusFilter !== undefined ? ` with status ${statusFilter}` : '';
    process.stdout.write(`No orders${scope}.\n`);
    return;
  }
  const style = createStyle(colorEnabled());
  const columns = Object.keys(COLUMN_TITLES) as Array<keyof typeof COLUMN_TITLES>;
  const rows = orders.map((order) => ({
    id: order.id,
    status: order.status,
    door: order.door,
    offering: order.offering,
    total: formatMoney(order.quote.totalCents, order.quote.currency),
    buyer: buyerText(order),
    created: formatInstant(order.createdAt),
  }));
  const widths = columns.map((column) =>
    Math.max(COLUMN_TITLES[column].length, ...rows.map((row) => row[column].length)),
  );
  process.stdout.write(`${columns.map((column, i) => pad(COLUMN_TITLES[column], widths[i] ?? 0)).join('  ')}\n`);
  for (const row of rows) {
    const cells = columns.map((column, i) => pad(row[column], widths[i] ?? 0));
    const statusIndex = columns.indexOf('status');
    if (statusIndex >= 0 && cells[statusIndex] !== undefined) {
      cells[statusIndex] = colorStatus(cells[statusIndex], style);
    }
    process.stdout.write(`${cells.join('  ')}\n`);
  }
  const awaiting = orders.filter((order) => order.status === 'awaiting_approval');
  if (awaiting.length > 0) {
    const first = awaiting[0]?.id ?? '…';
    process.stdout.write(
      `\n${awaiting.length} order(s) awaiting your approval — approve with: npm run sg -- orders approve ${first}\n`,
    );
  }
}

function printOrder(order: Order): void {
  const style = createStyle(colorEnabled());
  const hint = STATUS_HINT[order.status];
  process.stdout.write(`${style.bold(`order ${order.id}`)}\n`);
  field('status', colorStatus(order.status, style) + (hint !== undefined ? ` — ${hint}` : ''));
  if (order.statusReason !== undefined) field('reason', order.statusReason);
  if (order.voidOutcome !== undefined) field('void outcome', order.voidOutcome);
  field('door', order.door + (order.checkoutId !== undefined ? ` (checkout ${order.checkoutId})` : ''));
  field('confirmation', order.confirmation === 'owner_approves' ? 'owner approves before charge' : 'instant');
  field('offering', order.offering);
  field('total', `${formatMoney(order.quote.totalCents, order.quote.currency)} ${order.quote.currency}`);
  field('buyer', buyerText(order));
  field('created', formatInstant(order.createdAt));
  if (order.approvalDeadline !== undefined) field('approve by', formatInstant(order.approvalDeadline));
  if (order.stripe.checkoutSessionExpiresAt !== undefined)
    field('session expires', formatInstant(order.stripe.checkoutSessionExpiresAt));
  if (order.stripe.paymentIntentId !== undefined) field('payment intent', order.stripe.paymentIntentId);
  if (order.stripe.checkoutSessionId !== undefined) field('checkout session', order.stripe.checkoutSessionId);
  if (order.stripe.checkoutUrl !== undefined) field('payment page', order.stripe.checkoutUrl);
  if (order.refundedCents !== undefined) field('refunded', formatMoney(order.refundedCents, order.quote.currency));
  field('quote', order.quoteId);
  field('request', requestText(order));
  if (order.lastOperation !== undefined)
    field(
      'last op',
      `${order.lastOperation.op} → ${order.lastOperation.result} (${formatInstant(order.lastOperation.at)})`,
    );
  field('version', String(order.version));
  process.stdout.write(`\n${formatQuote(order.quote, formatMoney, style)}\n`);
}

/** `  label: value` row for printOrder, labels padded into one column. */
function field(label: string, value: string): void {
  process.stdout.write(`  ${pad(`${label}:`, 16)}${value}\n`);
}

function printActionResult(order: Order): void {
  const style = createStyle(colorEnabled());
  process.stdout.write(`${order.id}: ${colorStatus(order.status, style)}\n`);
  if (order.statusReason !== undefined) process.stdout.write(`  reason: ${order.statusReason}\n`);
  if (!IS_TERMINAL[order.status]) {
    process.stdout.write(
      `  still settling — the server finishes this state on its own; check again with\n  'npm run sg -- orders show ${order.id}' in a moment\n`,
    );
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Deep copy with every C0/C1 control character in strings and keys shown as
 * `\xNN`, so server-supplied (ultimately buyer-supplied) text prints inert.
 */
function escapeControls(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(CONTROL_CHARS, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  }
  if (Array.isArray(value)) return value.map(escapeControls);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [escapeControls(key), escapeControls(item)]));
  }
  return value;
}

/** Why `baseUrl` must not receive the admin token, or undefined when it may. */
function baseUrlProblem(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'is not an absolute URL (e.g. https://book.example.com)';
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LISTENING_LOCAL_HOSTS[url.hostname] === true) return undefined;
  return 'must use https — ADMIN_TOKEN would travel in cleartext (plain http only for localhost, 127.0.0.1, [::1])';
}

function colorStatus(status: string, style: Style): string {
  if (status === 'paid') return style.green(status);
  if (status === 'rejected' || status === 'payment_failed') return style.red(status);
  if (status === 'awaiting_approval') return style.yellow(status);
  if (status === 'expired' || status === 'canceled' || status === 'refunded') return style.dim(status);
  return status;
}

/** `2026-01-02 03:04Z` — server instants are UTC ISO strings. */
function formatInstant(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return iso;
  const utc = new Date(iso).toISOString();
  return `${utc.slice(0, 10)} ${utc.slice(11, 16)}Z`;
}

function buyerText(order: Order): string {
  const { buyer } = order;
  if (buyer === undefined) return '—';
  const contact = [buyer.email, buyer.phone].filter((part) => part !== undefined && part !== '');
  if (buyer.name !== undefined && contact.length > 0) return `${buyer.name} <${contact.join(' ')}>`;
  if (buyer.name !== undefined) return buyer.name;
  if (contact.length > 0) return contact.join(' ');
  return '—';
}

function requestText(order: Order): string {
  const parts: string[] = [];
  if (order.request.date !== undefined) parts.push(`date=${order.request.date}`);
  for (const [key, value] of Object.entries(order.request.answers)) parts.push(`${key}=${formatValue(value)}`);
  for (const [key, value] of Object.entries(order.request.selections)) parts.push(`${key}=[${value.join(', ')}]`);
  return parts.length > 0 ? parts.join(', ') : '(nothing asked)';
}
