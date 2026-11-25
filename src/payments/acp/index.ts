/**
 * ACP door (docs/payments.md § The four doors): REST `/acp/checkout_sessions…`, `GET /.well-known/acp.json`,
 * bearer auth (timing-safe), `API-Version` handling and `Idempotency-Key` rules per ACP
 * 2026-04-17 (https://www.agenticcommerce.dev/docs/reference/checkout).
 *
 * Optional signed order webhooks (`ACP_WEBHOOK_URL`): every state change of an ACP checkout's
 * order is delivered as `order_create`/`order_update` with the full order, signed
 * `Merchant-Signature: t=…,v1=…` (HMAC-SHA256 over `t.rawBody`). Delivery is a retryable
 * record processed by `deliverPendingAcpWebhooks`, which the core reconciler calls.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Buyer, DoorDeps, DoorModule, Order } from '../types.js';
import type { CheckoutCredential, CheckoutService, CheckoutOwner, LineItemInput } from '../checkout/index.js';
import { MAX_LINE_ITEMS, REFUSAL_STATUS } from '../checkout/index.js';
import { MAX_IDEMPOTENCY_KEY_LENGTH, createIdempotencyKeys, hashBody, idempotencyId, type IdempotencyKeys } from '../checkout/idempotency.js';
import {
  ACP_HANDLER,
  ACP_SUPPORTED_VERSIONS,
  acpError,
  acpRefusalError,
  acpOrderStatus,
  buildAcpDiscovery,
  renderAcpSession,
  type AcpContext,
} from './render.js';

const ACP_IDEMPOTENCY_COLLECTION = 'acp_idempotency';
const ACP_WEBHOOK_MAX_ATTEMPTS = 5;

const WEBHOOK_BACKOFF_MS = [0, 60_000, 300_000, 1_800_000, 7_200_000];
/** Order-webhook delivery timeout: a stalled endpoint must not stall the reconciler sweep. */
const WEBHOOK_TIMEOUT_MS = 10_000;

const BuyerRequest = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  email: z.string().optional(),
  phone_number: z.string().optional(),
});

const CreateRequest = z.object({
  buyer: BuyerRequest.optional(),
  line_items: z
    .array(z.object({ id: z.string().min(1), quantity: z.number().int().positive().optional() }))
    .min(1)
    .max(MAX_LINE_ITEMS),
  currency: z.string().optional(),
  quote_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateRequest = z.object({
  buyer: BuyerRequest.optional(),
  line_items: z.array(z.object({ id: z.string().min(1), quantity: z.number().int().positive().optional() })).min(1).max(MAX_LINE_ITEMS).optional(),
});

const CompleteRequest = z.object({
  buyer: BuyerRequest.optional(),
  payment_data: z.object({
    handler_id: z.string().optional(),
    instrument: z.object({
      type: z.string(),
      credential: z.object({ type: z.string(), token: z.string() }),
    }),
  }),
});

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buyerFromAcp(buyer: z.infer<typeof BuyerRequest> | undefined): Buyer | undefined {
  if (!buyer) return undefined;
  const out: Buyer = {};
  const name = (buyer.full_name ?? [buyer.first_name, buyer.last_name].filter(Boolean).join(' '))?.trim();
  if (name) out.name = name;
  if (buyer.email?.trim()) out.email = buyer.email.trim();
  if (buyer.phone_number?.trim()) out.phone = buyer.phone_number.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

function lineItemsFromAcp(items: Array<{ id: string; quantity?: number }>): LineItemInput[] {
  return items.map((item) => ({ id: item.id, quantity: item.quantity ?? 1 }));
}

/**
 * ACP complete credential: `payment_data.instrument` `{ type: 'card', credential: { type: 'spt', token } }`
 * (Stripe tokenized-card handler). Anything else is a recoverable `unsupported` message.
 */
function credentialFromAcp(payment: z.infer<typeof CompleteRequest>['payment_data'] | undefined): CheckoutCredential {
  if (!payment) return { ok: false, reason: 'The request has no payment_data.' };
  if (payment.handler_id && payment.handler_id !== ACP_HANDLER.id) {
    return { ok: false, reason: `Payment handler "${payment.handler_id}" is not available; use "${ACP_HANDLER.id}".` };
  }
  if (payment.instrument.type !== 'card') {
    return { ok: false, reason: `Instrument type "${payment.instrument.type}" is not supported; use "card".` };
  }
  if (payment.instrument.credential.type !== 'spt') {
    return { ok: false, reason: `Credential type "${payment.instrument.credential.type}" is not supported; use "spt".` };
  }
  const token = payment.instrument.credential.token;
  if (token.length === 0) return { ok: false, reason: 'The payment credential has no token.' };
  return { ok: true, spt: token };
}

export function createAcpDoor(deps: DoorDeps & { checkout: CheckoutService }): DoorModule {
  const { checkout, config, store } = deps;
  const acpConfig = config.acp;
  const acpContext = (): AcpContext => ({
    business: deps.getGraph().business,
    publicUrl: config.publicUrl,
    livemode: config.stripe.livemode,
    profileId: config.stripe.profileId,
  });
  const keys: IdempotencyKeys = createIdempotencyKeys(store, ACP_IDEMPOTENCY_COLLECTION, deps.now);

  const bearer = (req: Request): string | undefined => {
    const header = req.header('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  };

  /** Checkouts are bound to the bearer that created them: every door call carries its principal. */
  const ownerOf = (req: Request): CheckoutOwner => ({ door: 'acp', principal: sha256(bearer(req) ?? '') });

  /** Constant-time comparison over sha256 digests so token length never leaks. */
  function tokenMatches(provided: string): boolean {
    const digest = createHash('sha256').update(provided).digest();
    return (acpConfig?.bearerTokens ?? []).some((token) => {
      const candidate = createHash('sha256').update(token).digest();
      return digest.length === candidate.length && timingSafeEqual(digest, candidate);
    });
  }

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const token = bearer(req);
    if (!token || !tokenMatches(token)) {
      res.status(401).json(acpError('invalid_request', 'unauthorized', 'A valid bearer token (Authorization: Bearer …) is required.'));
      return;
    }
    next();
  }

  function requireApiVersion(req: Request, res: Response, next: NextFunction): void {
    const version = req.header('api-version');
    if (!version) {
      res.status(400).json(acpError('invalid_request', 'missing_api_version', `The API-Version header is required (supported: ${ACP_SUPPORTED_VERSIONS.join(', ')}).`, { supportedVersions: ACP_SUPPORTED_VERSIONS }));
      return;
    }
    if (!ACP_SUPPORTED_VERSIONS.includes(version)) {
      res.status(400).json(acpError('invalid_request', 'unsupported_api_version', `API-Version ${version} is not supported.`, { supportedVersions: ACP_SUPPORTED_VERSIONS }));
      return;
    }
    next();
  }

  /** ACP RFC §6: Idempotency-Key required on every POST; replay/in-flight/conflict semantics. */
  async function withIdempotency(req: Request, res: Response, fn: () => Promise<{ status: number; body: unknown; store?: boolean }>): Promise<void> {
    const key = req.header('idempotency-key');
    if (!key) {
      res.status(400).json(acpError('invalid_request', 'idempotency_key_required', 'Idempotency-Key header is required'));
      return;
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      res.status(400).json(acpError('invalid_request', 'invalid_idempotency_key', `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`));
      return;
    }
    // Keys are scoped to identity (token hash) + path, never the raw token.
    const path = req.originalUrl.split('?')[0] ?? req.url;
    const result = await keys.run(idempotencyId(sha256(bearer(req) ?? ''), path, key), hashBody(req.body), fn);
    switch (result.kind) {
      case 'replayed':
        res.status(result.status).setHeader('Idempotent-Replayed', 'true');
        res.json(result.body);
        return;
      case 'in_flight':
        res.status(409).setHeader('Retry-After', '1').setHeader('Idempotent-Replayed', 'false');
        res.json(acpError('invalid_request', 'idempotency_in_flight', 'A request with this Idempotency-Key is currently being processed'));
        return;
      case 'conflict':
        res.status(422).json(acpError('invalid_request', 'idempotency_conflict', 'Idempotency-Key has already been used with a different request body'));
        return;
      case 'executed':
        res.status(result.status).setHeader('Idempotent-Replayed', 'false');
        res.json(result.body);
        return;
    }
  }
  const notFound = (res: Response, id: string): void => {
    res.status(404).json(acpError('invalid_request', 'not_found', `No checkout session ${id}.`));
  };

  /** Order state may have changed under the complete/cancel call: deliver webhooks soon after. */
  const kickWebhooks = (): void => {
    if (acpConfig?.webhookUrl) {
      void deliverPendingAcpWebhooks(deps).catch((error) => console.error('[acp] order webhook delivery failed:', error));
    }
  };

  const router = Router();
  router.get('/.well-known/acp.json', (_req, res) => {
    res.json(buildAcpDiscovery(acpContext()));
  });

  router.use('/acp', requireAuth, requireApiVersion);

  router.post('/acp/checkout_sessions', (req, res) =>
    withIdempotency(req, res, async () => {
      const parsed = CreateRequest.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: acpErrorBody(parsed.error) };
      const result = await checkout.create(ownerOf(req), { lineItems: lineItemsFromAcp(parsed.data.line_items), buyer: buyerFromAcp(parsed.data.buyer) });
      // A refusal stores nothing (no session, and as a non-2xx no idempotency record either).
      if (!result.ok) return { status: REFUSAL_STATUS[result.reason], body: acpRefusalError(result) };
      return { status: 201, body: renderAcpSession(result.view, acpContext()) };
    }),
  );

  router.get('/acp/checkout_sessions/:id', async (req, res) => {
    const view = await checkout.get(ownerOf(req), req.params.id);
    if (!view) notFound(res, req.params.id);
    else res.json(renderAcpSession(view, acpContext()));
  });

  router.post('/acp/checkout_sessions/:id', (req, res) =>
    withIdempotency(req, res, async () => {
      const parsed = UpdateRequest.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: acpErrorBody(parsed.error) };
      const result = await checkout.update(ownerOf(req), req.params.id, {
        // Absent line_items keep the stored ones (ACP update is a partial update).
        ...(parsed.data.line_items !== undefined ? { lineItems: lineItemsFromAcp(parsed.data.line_items) } : {}),
        ...(parsed.data.buyer !== undefined ? { buyer: buyerFromAcp(parsed.data.buyer) ?? {} } : {}),
      });
      if (!result) return { status: 404, body: acpError('invalid_request', 'not_found', `No checkout session ${req.params.id}.`) };
      if (!result.ok) return { status: REFUSAL_STATUS[result.reason], body: acpRefusalError(result) };
      // An update sets the given fields: re-running it is idempotent by nature, so it is never stored
      // (fresh keys on repeated updates must not grow the store).
      return { status: 200, body: renderAcpSession(result.view, acpContext()), store: false };
    }),
  );

  router.post('/acp/checkout_sessions/:id/complete', (req, res) =>
    withIdempotency(req, res, async () => {
      const parsed = CompleteRequest.safeParse(req.body);
      if (!parsed.success) return { status: 400, body: acpErrorBody(parsed.error) };
      const view = await checkout.complete(ownerOf(req), req.params.id, { credential: credentialFromAcp(parsed.data.payment_data), buyer: buyerFromAcp(parsed.data.buyer) });
      if (!view) return { status: 404, body: acpError('invalid_request', 'not_found', `No checkout session ${req.params.id}.`) };
      kickWebhooks();
      // Only a call that changed state is replayed; a no-op or pending answer is re-derived on retry.
      return { status: 200, body: renderAcpSession(view, acpContext()), store: view.stateChanged === true };
    }),
  );

  router.post('/acp/checkout_sessions/:id/cancel', (req, res) =>
    withIdempotency(req, res, async () => {
      const view = await checkout.cancel(ownerOf(req), req.params.id);
      if (!view) return { status: 404, body: acpError('invalid_request', 'not_found', `No checkout session ${req.params.id}.`) };
      kickWebhooks();
      return { status: 200, body: renderAcpSession(view, acpContext()), store: view.stateChanged === true };
    }),
  );

  return { router };
}

/** Zod issues → protocol `Error` body (shape shared by every POST path). */
function acpErrorBody(error: z.ZodError) {
  const first = error.issues[0];
  return acpError(
    'invalid_request',
    'invalid_request',
    `${first?.path.join('.') ?? ''} ${first?.message ?? 'request validation failed'}`.trim(),
    { param: first?.path.length ? `$.${first!.path.join('.')}` : undefined },
  );
}

// ─── Order webhooks (outbox; the core reconciler calls this) ─────────────────

/** Full ACP order for a webhook payload: `data` must be the full Order, not deltas. */
function acpOrderJson(deps: DoorDeps, checkoutId: string, order: Order): Record<string, unknown> {
  const currency = order.quote.currency.toLowerCase();
  return {
    type: 'order',
    id: order.id,
    checkout_session_id: checkoutId,
    permalink_url: `${deps.config.publicUrl}/orders/${encodeURIComponent(order.id)}`,
    status: acpOrderStatus(order.status),
    line_items: order.quote.lines.map((line, index) => {
      // ACP quantities are integers ≥ 1 with unit_price × quantity = subtotal; any other
      // line (fractional or zero quantity, clamped discount) is one unit of its amount.
      const whole = line.quantity !== undefined && line.unitAmountCents !== undefined
        && Number.isInteger(line.quantity) && line.quantity >= 1
        && line.unitAmountCents * line.quantity === line.amountCents;
      const [units, unitPrice] = whole ? [line.quantity, line.unitAmountCents] : [1, line.amountCents];
      return {
        id: `li_${index + 1}`,
        title: line.label,
        quantity: { ordered: units, current: units, fulfilled: 0 },
        unit_price: unitPrice,
        subtotal: line.amountCents,
      };
    }),
    totals: [
      { type: 'subtotal', amount: order.quote.subtotalCents, display_text: `${(order.quote.subtotalCents / 100).toFixed(2)} ${currency}` },
      { type: 'total', amount: order.quote.totalCents, display_text: `${(order.quote.totalCents / 100).toFixed(2)} ${currency}` },
    ],
    confirmation: { confirmation_email_sent: false },
  };
}

/** True once the order has ever had an authorization (a hold, live or released). */
function hadAuthorization(order: Order): boolean {
  switch (order.status) {
    case 'awaiting_approval':
    case 'capturing':
    case 'voiding':
    case 'paid':
    case 'rejected':
    case 'expired':
    case 'refunded':
      return true;
    case 'awaiting_payment':
    case 'authorizing':
      return false;
    case 'canceled':
    case 'payment_failed':
      // Reachable with or without a hold; evidence of a PaymentIntent or a void decides.
      return order.stripe.paymentIntentId !== undefined || order.voidOutcome !== undefined;
  }
}

/**
 * Deliver pending ACP order webhooks (`Merchant-Signature: t=<unix>,v1=<hex>` HMAC-SHA256 over
 * `t.<rawBody>` when a secret is configured). `order_create` is sent only once an authorization
 * exists — never while `authorizing`, and never for an order that never had a hold — followed by
 * `order_update` for every later status change (a belated create whose order has already moved
 * past `awaiting_approval`/`paid` is immediately followed by an `order_update` to the current
 * status). Delivery state lives on the checkout record (`orderEvents`), so it is kept exactly as
 * long as the checkout and a prune can never make an old order re-create. Retries with backoff;
 * gives up after `ACP_WEBHOOK_MAX_ATTEMPTS` per status.
 */
export async function deliverPendingAcpWebhooks(deps: DoorDeps & { checkout: CheckoutService }, fetchImpl: typeof fetch = fetch): Promise<void> {
  const acpConfig = deps.config.acp;
  const url = acpConfig?.webhookUrl;
  if (!url) return;
  for (const record of deps.checkout.list('acp')) {
    const orderId = record.orderId;
    if (!orderId) continue;
    await deps.store.locks.withLock(`acpwh:${record.id}`, async () => {
      const order = await deps.service.getOrder(orderId);
      if (!order) return;
      const now = deps.now();
      const status = acpOrderStatus(order.status);
      const stored = deps.checkout.getOrderEvents(record.id);
      // State belongs to this checkout's current order; a new order starts with its own create.
      const state = stored && stored.orderId === orderId ? stored : undefined;
      if (state?.lastStatus === status && state.attempts === 0) return; // already delivered
      if (state && state.attempts > 0 && now.getTime() < Date.parse(state.nextAttemptAt)) return; // backoff
      if (!state?.created && !hadAuthorization(order)) return; // nothing to announce yet

      /** POST one event; false on any failure (network error or non-2xx). */
      const post = async (eventType: 'order_create' | 'order_update'): Promise<boolean> => {
        const body = JSON.stringify({ type: eventType, data: acpOrderJson(deps, record.id, order) });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (acpConfig?.webhookSecret) {
          const t = Math.floor(now.getTime() / 1000);
          const v1 = createHmac('sha256', acpConfig.webhookSecret).update(`${t}.${body}`).digest('hex');
          headers['Merchant-Signature'] = `t=${t},v1=${v1}`;
        }
        try {
          const response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
          if (response.ok) return true;
          console.error(`[acp] order webhook to ${url} for order ${order.id} got ${response.status} (${eventType})`);
          return false;
        } catch (error) {
          console.error(`[acp] order webhook to ${url} failed (${String(error)})`);
          return false;
        }
      };

      if (!state?.created) {
        // Belated create: the first attempt failed and the order may have moved on. Announce
        // it, then bring the platform straight to the current status with an order_update.
        if (await post('order_create')) {
          const settled = order.status === 'awaiting_approval' || order.status === 'paid';
          if (settled || (await post('order_update'))) {
            await deps.checkout.setOrderEvents(record.id, {
              orderId,
              lastStatus: status,
              created: true,
              lastSentAt: now.toISOString(),
              attempts: 0,
              nextAttemptAt: now.toISOString(),
            });
            return;
          }
          // Create delivered, update did not: the next sweep sends the update.
          await deps.checkout.setOrderEvents(record.id, {
            orderId,
            created: true,
            lastSentAt: now.toISOString(),
            attempts: 1,
            nextAttemptAt: new Date(now.getTime() + (WEBHOOK_BACKOFF_MS[1] ?? 60_000)).toISOString(),
          });
          return;
        }
      } else if (await post('order_update')) {
        await deps.checkout.setOrderEvents(record.id, {
          orderId,
          lastStatus: status,
          created: true,
          lastSentAt: now.toISOString(),
          attempts: 0,
          nextAttemptAt: now.toISOString(),
        });
        return;
      }
      const attempts = (state?.attempts ?? 0) + 1;
      const gaveUp = attempts >= ACP_WEBHOOK_MAX_ATTEMPTS;
      if (gaveUp) {
        console.error(`[acp] order webhook to ${url} for order ${order.id} gave up after ${attempts} attempts`);
      }
      const backoff = WEBHOOK_BACKOFF_MS[Math.min(attempts, WEBHOOK_BACKOFF_MS.length - 1)] ?? 0;
      await deps.checkout.setOrderEvents(record.id, gaveUp
        ? {
            orderId,
            lastStatus: status, // stop resending this status on later sweeps
            created: state?.created ?? false,
            lastSentAt: state?.lastSentAt,
            attempts: 0,
            nextAttemptAt: now.toISOString(),
          }
        : {
            orderId,
            lastStatus: state?.lastStatus,
            created: state?.created ?? false,
            lastSentAt: state?.lastSentAt,
            attempts,
            nextAttemptAt: new Date(now.getTime() + backoff).toISOString(),
          });
    });
  }
}

