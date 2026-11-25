/**
 * MPP door (docs/payments.md § The four doors): HTTP-only, instant-only machine payments.
 *
 * `POST /mpp/quotes/:qt/pay` answers with mppx (MPP `stripe/charge`):
 *   - quote unknown            → 404
 *   - quote expired            → 403 problem+json
 *   - live order on other door → 403 problem+json (`quote_in_use`)
 *   - already paid via MPP     → 200 with the order
 *   - no/invalid credential    → 402 challenge (amount/currency from the FROZEN
 *     quote; caller-supplied amounts are never read)
 *   - verified credential      → `payWithSpt(door=mpp, requireSettled)` and 200
 *     with the order + `Payment-Receipt`; the order MUST be `paid` first
 *     (MPP: settled before 200).
 *   - outcome unknown          → 503 problem+json `payment_pending` with
 *     `Retry-After`; the challenge claim is RELEASED so the SAME credential
 *     retries into the SAME order. Never 402 here (a fresh credential on a
 *     pending order double-pays) and never "nothing was charged" (the sweep
 *     may still settle it).
 *
 * The challenge secret is HMAC-derived from `ORDER_SIGNING_SECRET` with domain
 * separator `scopegraph/mpp/v1`; the realm is pinned to the `PUBLIC_URL` host.
 * Challenges are single-use via an in-memory claim map. No Tempo.
 *
 * Locking: `payWithSpt`/`startOrder` run under the service's own per-quote and
 * per-order locks (the single funnel); this door does NOT take those locks
 * itself — double-locking would violate the checkout → quote → order
 * acquisition order and risks self-deadlock.
 */
import { createHmac } from 'node:crypto';
import { Router } from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { Errors, Method } from 'mppx';
import type { Receipt } from 'mppx';
import { Methods as StripeMethods } from 'mppx/stripe';
import { Mppx } from 'mppx/server';
import { IS_TERMINAL } from '../types.js';
import type { DoorDeps, DoorModule, Order, PublicOrder, ServiceError, StoredQuote } from '../types.js';

/** Domain separator for the MPP challenge secret. */
const MPP_DOMAIN_SEPARATOR = 'scopegraph/mpp/v1';

/** Challenge lifetime: capped at 15 min and never beyond the quote expiry. */
const CHALLENGE_TTL_MS = 15 * 60_000;

/** Claimed challenges older than this are prunable (challenge TTL + slack). */
const CLAIM_GC_MS = 60 * 60_000;

/** Seconds a `payment_pending` client should wait before retrying the SAME credential. */
const PENDING_RETRY_AFTER_SECONDS = '5';

/**
 * Service refusals that provably moved no money for this request: the quote
 * was never chargeable, the door was never opened, or the payment ended
 * terminal-unpaid with no unresolved release (`payment_declined` — the
 * service answers `payment_pending` whenever the outcome is unknown).
 * `quote_in_use` is deliberately absent: another door's payment may be in
 * flight for this quote. Everything else is answered verbatim, with NO claim
 * about charges. Exhaustive: adding a ServiceError forces a decision here.
 */
const NO_CHARGE_REFUSALS: Record<ServiceError | 'not_settled', boolean> = {
  quote_not_found: true,
  quote_expired: true,
  requote_required: true,
  amount_too_small: true,
  door_unavailable: true,
  payment_declined: true,
  quote_in_use: false,
  order_not_found: false,
  invalid_state: false,
  different_credential: false,
  buyer_email_required: false,
  too_many_attempts: false,
  payment_pending: false,
  not_settled: true,
};

/** mppx's stripe `amount` field is MAJOR units; the frozen quote is minor units. */
function majorUnits(totalCents: number): string {
  return `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, '0')}`;
}

/** mppx requires ≥32-byte secret keys; hex(HMAC-SHA256) is 64 chars. */
export function mppSecretKey(signingSecret: string): string {
  return createHmac('sha256', signingSecret).update(MPP_DOMAIN_SEPARATOR).digest('hex');
}

/** In-memory single-use claim map for challenge ids. */
class SingleUseClaims {
  private readonly claimedAt = new Map<string, number>();

  /** Claims `id` once; false when it was already used. Prunes stale entries. */
  claim(id: string, nowMs: number): boolean {
    if (this.claimedAt.has(id)) return false;
    for (const [claimed, at] of this.claimedAt) {
      if (nowMs - at > CLAIM_GC_MS) this.claimedAt.delete(claimed);
    }
    this.claimedAt.set(id, nowMs);
    return true;
  }

  /** Frees a claim after an unexpected (non-definitive) failure so the client may retry. */
  release(id: string): void {
    this.claimedAt.delete(id);
  }
}

/** What the per-request `verify` hook reports back to the route handler. */
interface VerifyOutcome {
  /** Set when the service refused payment: the 402 becomes 403 problem+json. */
  refusal?: { error: ServiceError | 'not_settled'; message: string };
  /** The settled order on success. */
  order?: Order;
}

/** Refusals that must NOT look like a payable challenge. RFC 9457 body. */
function problem(res: ExpressResponse, status: 403 | 404, title: string, detail: string): void {
  res
    .status(status)
    .setHeader('Cache-Control', 'no-store')
    .contentType('application/problem+json')
    .json({ type: 'about:blank', title, status, detail });
}

/** Unknown Stripe outcome: retryable 503 problem+json, never a payable challenge. */
function pendingProblem(res: ExpressResponse, order?: PublicOrder): void {
  res
    .status(503)
    .setHeader('Cache-Control', 'no-store')
    .setHeader('Retry-After', PENDING_RETRY_AFTER_SECONDS)
    .contentType('application/problem+json')
    .json({
      type: 'about:blank',
      title: 'payment_pending',
      status: 503,
      detail:
        'The card network has not confirmed the outcome of this payment attempt yet. ' +
        'Retry this request shortly with the SAME payment credential: the same order resumes and no second payment is created. ' +
        'Do not pay this quote another way while this attempt is pending.',
      ...(order !== undefined ? { order } : {}),
    });
}

/** Definitive service refusal: 403 problem+json; "no charge" only when provably true. */
function refusalProblem(res: ExpressResponse, refusal: NonNullable<VerifyOutcome['refusal']>): void {
  const detail = NO_CHARGE_REFUSALS[refusal.error] ? `${refusal.message} No payment was taken.` : refusal.message;
  problem(res, 403, refusal.error, detail);
}

/** min(quote expiry, now + TTL), as ISO 8601 for the challenge `expires`. */
function challengeExpiry(deps: DoorDeps, quote: StoredQuote): string {
  const cap = deps.now().getTime() + CHALLENGE_TTL_MS;
  const quoteExpiry = Date.parse(quote.expiresAt);
  return new Date(Math.min(cap, quoteExpiry)).toISOString();
}

/** The custom `stripe/charge` server method: verification IS the order funnel. */
function createScopegraphChargeMethod(deps: DoorDeps, quote: StoredQuote, claims: SingleUseClaims, outcome: VerifyOutcome) {
  const networkId = deps.config.stripe.profileId ?? 'internal';
  return Method.toServer(StripeMethods.charge, {
    defaults: { networkId, paymentMethodTypes: ['card'] },
    async verify({ credential }) {
      const parsedPayload = StripeMethods.charge.schema.credential.payload.safeParse(credential.payload);
      if (!parsedPayload.success) {
        throw new Errors.VerificationFailedError({ reason: 'Credential has no valid shared payment token' });
      }
      const { spt, externalId } = parsedPayload.data;
      if (externalId !== undefined && externalId !== quote.id) {
        throw new Errors.VerificationFailedError({ reason: 'Credential was not issued for this quote' });
      }
      const challengeId = credential.challenge.id;
      if (!claims.claim(challengeId, deps.now().getTime())) {
        // 402 + fresh challenge (mppx native): the client may pay again, just
        // never with this challenge id.
        throw new Errors.InvalidChallengeError({ id: challengeId, reason: 'already used' });
      }

      let result;
      try {
        result = await deps.service.payWithSpt({ quoteId: quote.id, door: 'mpp', spt, requireSettled: true });
      } catch (error) {
        // Unexpected failure (bug/transport): outcome unknown. Release the
        // claim so a reconciled retry works, and surface a generic 500 —
        // never a 402 that would invite an auto-paying client to pay twice.
        // Service refusals below stay consumed (definitive).
        claims.release(challengeId);
        throw new Errors.InternalPaymentError({ cause: error });
      }
      if (!result.ok) {
        outcome.refusal = { error: result.error, message: result.message };
        if (result.error === 'payment_pending') {
          // Outcome unknown: the SAME credential must be able to retry
          // into the SAME order, so the single-use claim goes back.
          claims.release(challengeId);
        }
        throw new Errors.VerificationFailedError({ reason: result.error });
      }
      const order = result.value;
      if (order.status !== 'paid') {
        if (!IS_TERMINAL[order.status]) {
          // Defensive (service contract: ok ⇒ paid for requireSettled). A
          // processing order is an UNKNOWN outcome → pending, claim released.
          outcome.refusal = { error: 'payment_pending', message: '' };
          claims.release(challengeId);
          throw new Errors.VerificationFailedError({ reason: `Order ${order.id} is ${order.status}` });
        }
        // Terminal-unpaid with no unresolved release: money definitively did not move.
        outcome.refusal = {
          error: order.status === 'canceled' && order.statusReason === 'not_settled' ? 'not_settled' : 'payment_declined',
          message: `Payment did not settle (order ${order.id} is ${order.status}${order.statusReason !== undefined ? `: ${order.statusReason}` : ''}).`,
        };
        throw new Errors.VerificationFailedError({ reason: `Order status: ${order.status}` });
      }
      outcome.order = order;
      const receipt: Receipt.Receipt = {
        method: 'stripe',
        status: 'success',
        timestamp: deps.now().toISOString(),
        reference: order.stripe.paymentIntentId ?? order.id,
      };
      return receipt;
    },
  });
}

/** express Request → Fetch Request (credential + content negotiation only; no body). */
function toFetchRequest(req: ExpressRequest, baseUrl: string): Request {
  const headers = new Headers();
  if (typeof req.headers.authorization === 'string') headers.set('authorization', req.headers.authorization);
  if (typeof req.headers.accept === 'string') headers.set('accept', req.headers.accept);
  return new Request(new URL(req.originalUrl, baseUrl).toString(), { method: 'POST', headers });
}

/** Fetch Response → express response (status, headers, body). */
async function sendFetchResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  res.send(Buffer.from(await response.arrayBuffer()));
}

export function createMppDoor(deps: DoorDeps): DoorModule {
  // MPP is mounted only for instant confirmation (`MPP_ENABLED` + instant);
  // see docs/payments.md § Owner approval vs instant.
  if (!deps.config.mppEnabled || deps.config.confirmation !== 'instant') return {};

  const router = Router();
  const secretKey = mppSecretKey(deps.config.signingSecret);
  const realm = new URL(deps.config.publicUrl).host;
  const claims = new SingleUseClaims();

  router.post('/mpp/quotes/:qt/pay', async (req, res) => {
    const quoteId = req.params.qt;
    // Live order FIRST (door side): a payment_pending retry must
    // resume the SAME order even after the quote expired or was pruned
    // (quotes are memory-only until an order starts).
    const live = await deps.service.getLiveOrderForQuote(quoteId);
    if (live && live.door !== 'mpp') {
      problem(res, 403, 'quote_in_use', 'This quote is already being paid through another payment method.');
      return;
    }
    if (live && live.status === 'paid') {
      res.status(200).json(deps.service.toPublic(live));
      return;
    }
    const quote = await deps.service.getQuote(quoteId);
    if (quote === undefined && live === undefined) {
      problem(res, 404, 'quote_not_found', 'No such quote. Scope the request again.');
      return;
    }
    if (quote !== undefined && live === undefined && Date.parse(quote.expiresAt) <= deps.now().getTime()) {
      problem(res, 403, 'quote_expired', 'This quote has expired. Scope the request again for a fresh quote.');
      return;
    }
    // Frozen amounts for the challenge: the stored quote, else the live order's frozen copy.
    const frozen: StoredQuote = quote ?? {
      id: quoteId,
      offering: live!.offering,
      request: live!.request,
      quote: live!.quote,
      createdAt: live!.createdAt,
      expiresAt: new Date(deps.now().getTime() + CHALLENGE_TTL_MS).toISOString(),
    };
    // While resuming a live order the (possibly expired) quote must not drag
    // the challenge expiry into the past: cap at the TTL only.
    const expires =
      quote !== undefined && live === undefined
        ? challengeExpiry(deps, quote)
        : new Date(deps.now().getTime() + CHALLENGE_TTL_MS).toISOString();

    const outcome: VerifyOutcome = {};
    const method = createScopegraphChargeMethod(deps, frozen, claims, outcome);
    const mppx = Mppx.create({ methods: [method], secretKey, realm });
    const handler = mppx.charge({
      amount: majorUnits(frozen.quote.totalCents),
      currency: frozen.quote.currency.toLowerCase(),
      decimals: 2,
      networkId: deps.config.stripe.profileId ?? 'internal',
      paymentMethodTypes: ['card'],
      description: `${deps.getGraph().business.name} — ${frozen.offering}`,
      externalId: frozen.id,
      expires,
    });
    const result = await handler(toFetchRequest(req, deps.config.publicUrl));

    if (result.status === 200) {
      const response = await result.withReceipt(Response.json(deps.service.toPublic(outcome.order!)));
      await sendFetchResponse(res, response);
      return;
    }
    // A refusal recorded by `verify` is definitive-ish, never a retry challenge…
    if (outcome.refusal) {
      if (outcome.refusal.error === 'payment_pending') {
        // …except the one that isn't: unknown outcome → retryable 503.
        const current = live ?? (await deps.service.getLiveOrderForQuote(quoteId));
        pendingProblem(res, current !== undefined && current.door === 'mpp' ? deps.service.toPublic(current) : undefined);
        return;
      }
      refusalProblem(res, outcome.refusal);
      return;
    }
    // 402 with no refusal: normally a fresh challenge. But while an MPP
    // attempt is pending for this quote, a new challenge would invite a NEW
    // credential (the service refuses those: different_credential) — answer
    // payment_pending instead and let the held credential retry or the
    // reconciler settle it.
    const liveNow = await deps.service.getLiveOrderForQuote(quoteId);
    if (liveNow !== undefined && liveNow.door === 'mpp' && !IS_TERMINAL[liveNow.status]) {
      pendingProblem(res, deps.service.toPublic(liveNow));
      return;
    }
    await sendFetchResponse(res, result.challenge);
  });

  return { router };
}
