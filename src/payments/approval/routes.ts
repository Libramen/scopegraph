/**
 * Owner-facing HTTP surface.
 *
 *   GET  /orders/:id                 public status page (no PII, no answers)
 *   GET  /orders/:id/approve?t=…     confirmation page (never mutates; prefetch-safe)
 *   GET  /orders/:id/reject?t=…      confirmation page with optional reason
 *   POST /orders/:id/approve?t=…     consumes the link's nonce, then approves
 *   POST /orders/:id/reject?t=…      consumes the link's nonce, then rejects (reason ≤ 500)
 *   GET  /admin/orders?status=       admin list   (Bearer ADMIN_TOKEN)
 *   GET  /admin/orders/:id           admin detail (full order incl. buyer)
 *   POST /admin/orders/:id/approve   admin approve
 *   POST /admin/orders/:id/reject    admin reject { reason? }
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import type { Graph } from '../../graph/types.js';
import type { Order, OrderService, OrderStatus, PaymentsConfig, ServiceError } from '../types.js';
import { IS_TERMINAL } from '../types.js';
import type { PaymentsStore } from '../store/index.js';
import { isId } from '../store/index.js';
import { escapeHtml, formatMoney, sendHtml } from './html.js';
import { verifyApprovalToken } from './tokens.js';
import type { ApprovalAction } from './tokens.js';

export interface ApprovalRouterDeps {
  service: OrderService;
  store: PaymentsStore;
  config: PaymentsConfig;
  getGraph: () => Graph;
  now: () => Date;
}

const REASON_MAX = 500;

const STATUS_TEXT: Record<OrderStatus, string> = {
  awaiting_payment: 'Waiting for the buyer to pay',
  authorizing: 'Authorizing the card',
  awaiting_approval: 'Card authorized — waiting for the business to confirm',
  capturing: 'Confirming the payment',
  voiding: 'Releasing the card authorization',
  paid: 'Paid',
  rejected: 'Declined by the business — the card was not charged',
  expired: 'Expired — the card was not charged',
  canceled: 'Canceled — the card was not charged',
  payment_failed: 'Payment failed — the card was not charged',
  refunded: 'Refunded',
};

function offeringName(graph: Graph, order: Order): string {
  return graph.offerings[order.offering]?.name ?? order.offering;
}

function statusBlock(order: Order, graph: Graph): string {
  const rows = [
    `<p class="status">${escapeHtml(STATUS_TEXT[order.status])}</p>`,
    `<p>${escapeHtml(offeringName(graph, order))} — ${escapeHtml(formatMoney(order.quote.totalCents, order.quote.currency))}</p>`,
  ];
  if (order.status === 'awaiting_approval' && order.approvalDeadline !== undefined) {
    rows.push(`<p class="muted">Decision due by ${escapeHtml(order.approvalDeadline)}.</p>`);
  }
  if (order.statusReason !== undefined) rows.push(`<p class="muted">Reason: ${escapeHtml(order.statusReason)}</p>`);
  rows.push(`<p class="muted">Order ${escapeHtml(order.id)}</p>`);
  return rows.join('');
}

function cliHint(order: Order): string {
  return `<p class="muted">You can still act from a terminal: <code>scopegraph orders approve ${escapeHtml(order.id)}</code>`
    + ` or <code>scopegraph orders reject ${escapeHtml(order.id)}</code>.</p>`;
}

function formatAnswer(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(', ') : String(value);
}

/** Everything the owner needs to decide. Escaped; shown only behind a valid signed link. */
function detailBlock(order: Order, graph: Graph): string {
  const lines = order.quote.lines
    .map((line) => `<tr><td>${escapeHtml(line.label)}${line.quantity !== undefined && line.quantity !== 1 ? ` ×${escapeHtml(String(line.quantity))}` : ''}</td>`
      + `<td class="amount">${escapeHtml(formatMoney(line.amountCents, order.quote.currency))}</td></tr>`)
    .join('');
  const totals = [
    order.quote.taxCents !== 0 ? `<tr><td>Tax</td><td class="amount">${escapeHtml(formatMoney(order.quote.taxCents, order.quote.currency))}</td></tr>` : '',
    `<tr><td><strong>Total</strong></td><td class="amount"><strong>${escapeHtml(formatMoney(order.quote.totalCents, order.quote.currency))}</strong></td></tr>`,
  ].join('');
  const buyer = order.buyer;
  const contact = buyer === undefined
    ? '<p class="muted">No buyer contact details were provided.</p>'
    : `<ul>${[buyer.name, buyer.email, buyer.phone].filter((v): v is string => v !== undefined && v !== '').map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ul>`;
  const answers = Object.entries(order.request.answers)
    .map(([key, value]) => `<li>${escapeHtml(key)}: ${escapeHtml(formatAnswer(value))}</li>`);
  for (const [group, keys] of Object.entries(order.request.selections)) {
    answers.push(`<li>${escapeHtml(group)}: ${escapeHtml(keys.join(', '))}</li>`);
  }
  if (order.request.date !== undefined) answers.push(`<li>date: ${escapeHtml(order.request.date)}</li>`);
  return [
    `<h2>${escapeHtml(offeringName(graph, order))}</h2>`,
    `<table>${lines}${totals}</table>`,
    '<h2>Buyer</h2>',
    contact,
    '<h2>Request</h2>',
    answers.length > 0 ? `<ul>${answers.join('')}</ul>` : '<p class="muted">No answers.</p>',
  ].join('');
}

function queryToken(req: Request): unknown {
  const fromQuery = req.query['t'];
  if (typeof fromQuery === 'string') return fromQuery;
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && 't' in body ? body.t : undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isAdminBearer(authorization: string | undefined, adminDigest: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match !== null && match[1] !== undefined && timingSafeEqual(digest(match[1].trim()), adminDigest);
}

const OWNER_DECISION_PATH = /^\/orders\/([^/]+)\/(approve|reject)\/?$/;

/**
 * The owner's routes: signed approve/reject pages and POSTs, and `/admin`.
 * They never share the public rate-limit bucket.
 */
export function isOwnerRoute(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || OWNER_DECISION_PATH.test(path);
}

/**
 * True when an owner-route request carries a real credential: the ADMIN_TOKEN
 * bearer, or a signature-valid, unexpired approval token for exactly this
 * order and action (`?t=`). Such requests skip rate limiting entirely; the
 * nonce is still single-use when the POST acts.
 */
export function hasOwnerCredential(
  request: { path: string; authorization: string | undefined; token: unknown },
  config: Pick<PaymentsConfig, 'adminToken' | 'signingSecret'>,
  now: Date,
): boolean {
  if (isAdminBearer(request.authorization, digest(config.adminToken))) return true;
  const decision = OWNER_DECISION_PATH.exec(request.path);
  if (decision === null) return false;
  const orderId = decision[1];
  if (orderId === undefined) return false;
  const action: ApprovalAction = decision[2] === 'approve' ? 'approve' : 'reject';
  return verifyApprovalToken(request.token, { orderId, action, now, secret: config.signingSecret }).ok;
}

const ADMIN_ERROR_STATUS: Partial<Record<ServiceError, number>> = {
  order_not_found: 404,
  invalid_state: 409,
};

export function createApprovalRouter(deps: ApprovalRouterDeps): Router {
  const { service, store, config, getGraph, now } = deps;
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '8kb' });

  const notFound = (res: Response): void => {
    sendHtml(res, 404, 'Order not found', '<p>This order does not exist or is no longer available.</p>');
  };

  router.get('/orders/:id', async (req: Request<{ id: string }>, res) => {
    const order = isId('ord', req.params.id) ? await service.getOrder(req.params.id) : undefined;
    if (order === undefined) {
      notFound(res);
      return;
    }
    sendHtml(res, 200, 'Order status', statusBlock(order, getGraph()));
  });

  const confirm = (action: ApprovalAction) => async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const order = isId('ord', req.params.id) ? await service.getOrder(req.params.id) : undefined;
    if (order === undefined) {
      notFound(res);
      return;
    }
    const graph = getGraph();
    const check = verifyApprovalToken(queryToken(req), { orderId: order.id, action, now: now(), secret: config.signingSecret });
    if (!check.ok) {
      sendHtml(res, 403, check.reason === 'expired' ? 'This link has expired' : 'This link is not valid', statusBlock(order, graph) + cliHint(order));
      return;
    }
    if (store.isNonceConsumed(check.nonce)) {
      sendHtml(res, 409, 'This link was already used', statusBlock(order, graph) + cliHint(order));
      return;
    }
    if (order.status !== 'awaiting_approval') {
      sendHtml(res, 200, 'Nothing to decide', statusBlock(order, graph));
      return;
    }
    const tokenParam = encodeURIComponent(String(queryToken(req)));
    // Relative to /orders/<id>/<action>: same origin (CSP form-action 'self'), proxy-prefix safe.
    const actionUrl = `${action}?t=${tokenParam}`;
    const formHtml = action === 'approve'
      ? `<form method="post" action="${escapeHtml(actionUrl)}"><p>Approving charges the buyer's card ${escapeHtml(formatMoney(order.quote.totalCents, order.quote.currency))} now.</p>`
        + '<button type="submit">Approve and charge</button></form>'
      : `<form method="post" action="${escapeHtml(actionUrl)}"><p>Rejecting releases the card authorization; the buyer is not charged.</p>`
        + `<label for="reason">Reason shown to the buyer (optional)</label><textarea id="reason" name="reason" maxlength="${String(REASON_MAX)}" rows="3"></textarea>`
        + '<button type="submit">Reject</button></form>';
    sendHtml(
      res,
      200,
      action === 'approve' ? 'Approve this order?' : 'Reject this order?',
      `${detailBlock(order, graph)}<p class="muted">Decide by ${escapeHtml(order.approvalDeadline ?? '')}.</p>${formHtml}`,
    );
  };

  const act = (action: ApprovalAction) => async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const order = isId('ord', req.params.id) ? await service.getOrder(req.params.id) : undefined;
    if (order === undefined) {
      notFound(res);
      return;
    }
    const graph = getGraph();
    const check = verifyApprovalToken(queryToken(req), { orderId: order.id, action, now: now(), secret: config.signingSecret });
    if (!check.ok) {
      sendHtml(res, 403, check.reason === 'expired' ? 'This link has expired' : 'This link is not valid', statusBlock(order, graph) + cliHint(order));
      return;
    }
    const claimed = await store.claimNonce(check.nonce, {
      orderId: order.id,
      consumedAt: now().toISOString(),
      expiresAt: check.expiresAt.toISOString(),
    });
    if (!claimed) {
      const current = (await service.getOrder(order.id)) ?? order;
      sendHtml(res, 409, 'This link was already used', statusBlock(current, graph) + cliHint(current));
      return;
    }
    const body: unknown = req.body;
    const rawReason = typeof body === 'object' && body !== null && 'reason' in body && typeof body.reason === 'string' ? body.reason : undefined;
    const result = action === 'approve'
      ? await service.approve(order.id)
      : await service.reject(order.id, rawReason?.slice(0, REASON_MAX));
    if (!result.ok) {
      const current = (await service.getOrder(order.id)) ?? order;
      sendHtml(res, 409, 'Nothing was changed', `<p>${escapeHtml(result.message)}</p>${statusBlock(current, graph)}`);
      return;
    }
    const done = result.value;
    const title = done.status === 'paid'
      ? 'Approved — payment captured'
      : done.status === 'rejected'
        ? 'Rejected — the card authorization was released'
        : IS_TERMINAL[done.status]
          ? 'The order could not be completed'
          : 'Working on it';
    sendHtml(res, 200, title, statusBlock(done, graph));
  };

  router.get('/orders/:id/approve', confirm('approve'));
  router.get('/orders/:id/reject', confirm('reject'));
  router.post('/orders/:id/approve', form, act('approve'));
  router.post('/orders/:id/reject', form, act('reject'));

  // ── Admin API ──────────────────────────────────────────────────────────────
  const adminDigest = digest(config.adminToken);
  const admin = express.Router();
  admin.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isAdminBearer(req.get('authorization'), adminDigest)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'unauthorized', message: 'Send Authorization: Bearer <ADMIN_TOKEN>.' });
      return;
    }
    next();
  });

  admin.get('/orders', async (req, res) => {
    const status = req.query['status'];
    if (status !== undefined && (typeof status !== 'string' || !Object.hasOwn(IS_TERMINAL, status))) {
      res.status(400).json({ error: 'invalid_request', message: `status must be one of: ${Object.keys(IS_TERMINAL).join(', ')}.` });
      return;
    }
    const orders = await service.listOrders(status === undefined ? undefined : { status: status as OrderStatus });
    res.json({ orders });
  });

  admin.get('/orders/:id', async (req: Request<{ id: string }>, res) => {
    const order = isId('ord', req.params.id) ? await service.getOrder(req.params.id) : undefined;
    if (order === undefined) {
      res.status(404).json({ error: 'order_not_found', message: `Order ${req.params.id} not found.` });
      return;
    }
    res.json({ order });
  });

  admin.post('/orders/:id/approve', async (req: Request<{ id: string }>, res) => {
    if (!isId('ord', req.params.id)) {
      res.status(404).json({ error: 'order_not_found', message: `Order ${req.params.id} not found.` });
      return;
    }
    const result = await service.approve(req.params.id);
    if (!result.ok) {
      res.status(ADMIN_ERROR_STATUS[result.error] ?? 400).json({ error: result.error, message: result.message });
      return;
    }
    res.json({ order: result.value });
  });

  admin.post('/orders/:id/reject', async (req: Request<{ id: string }>, res) => {
    if (!isId('ord', req.params.id)) {
      res.status(404).json({ error: 'order_not_found', message: `Order ${req.params.id} not found.` });
      return;
    }
    const body: unknown = req.body;
    let reason: string | undefined;
    if (typeof body === 'object' && body !== null && 'reason' in body && body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string' || body.reason.length > REASON_MAX) {
        res.status(400).json({ error: 'invalid_request', message: `reason must be a string of at most ${String(REASON_MAX)} characters.` });
        return;
      }
      reason = body.reason;
    }
    const result = await service.reject(req.params.id, reason);
    if (!result.ok) {
      res.status(ADMIN_ERROR_STATUS[result.error] ?? 400).json({ error: result.error, message: result.message });
      return;
    }
    res.json({ order: result.value });
  });

  router.use('/admin', admin);
  return router;
}
