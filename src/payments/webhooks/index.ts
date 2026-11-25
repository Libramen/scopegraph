/**
 * POST /webhooks/stripe — Stripe events are triggers only.
 *
 * The signature is verified on the RAW body (this route parses its own body;
 * the app-level JSON parser skips it). The event's object is then re-read from
 * Stripe by the order service, which applies the observation table under the
 * order lock — so replays, reordering and duplicates are harmless and no
 * dedupe store exists. Not rate limited (Stripe retries on non-2xx).
 *
 * The endpoint must be subscribed to STRIPE_WEBHOOK_EVENTS (used by
 * `scopegraph doctor` and listed in docs/payments.md).
 */
import express, { type Router } from 'express';
import type { OrderService, PaymentGateway } from '../types.js';
import { redactStripeSecrets } from '../stripe/scrub.js';

export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe';
/** Raw body cap: the subscribed events are a few KB; anything larger is refused (413) before the HMAC. */
const WEBHOOK_BODY_LIMIT = '256kb';

/** Events the Stripe webhook endpoint must be subscribed to. */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.expired',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
] as const;

export function createWebhookRouter(deps: {
  gateway: PaymentGateway;
  service: OrderService;
  /** Called after each handled event (the reconciler sweep piggybacks on triggers). */
  onTrigger?: () => void;
}): Router {
  const router = express.Router();
  router.post(STRIPE_WEBHOOK_PATH, express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }), async (req, res) => {
    const raw: unknown = req.body;
    if (!Buffer.isBuffer(raw)) {
      res.status(400).json({ error: 'invalid_request', message: 'Expected a raw Stripe event body.' });
      return;
    }
    const event = deps.gateway.verifyWebhook(raw, req.get('stripe-signature'));
    if (event === undefined) {
      res.status(400).json({ error: 'invalid_signature', message: 'Stripe signature verification failed.' });
      return;
    }
    try {
      await deps.service.handleStripeTrigger(event);
    } catch (err) {
      // Outcome unknown (Stripe unreachable while re-reading), or a void/refund of money
      // the order must not keep is still unresolved: 500 so Stripe redelivers.
      console.error(redactStripeSecrets(`scopegraph payments: webhook ${event.type} for ${event.objectId} failed: ${err instanceof Error ? err.message : String(err)}`));
      res.status(500).json({ error: 'retry_later' });
      return;
    }
    deps.onTrigger?.();
    res.json({ received: true });
  });
  return router;
}
