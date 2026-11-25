import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness } from '../orders/test-harness.js';
import type { Harness } from '../orders/test-harness.js';
import { createWebhookRouter } from './index.js';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function serve(h: Harness, onTrigger?: () => void): Promise<string> {
  const app = express();
  // Mirrors createApp: the JSON parser must not consume the webhook body.
  const json = express.json();
  app.use((req, res, next) => (req.path === '/webhooks/stripe' ? next() : json(req, res, next)));
  app.use(createWebhookRouter({ gateway: h.gateway, service: h.service, ...(onTrigger !== undefined ? { onTrigger } : {}) }));
  const s = app.listen(0, '127.0.0.1');
  server = s;
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  return `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
}

function post(url: string, body: string, signature?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature !== undefined ? { 'stripe-signature': signature } : {}) },
    body,
  });
}

describe('POST /webhooks/stripe', () => {
  it('rejects bad or missing signatures without touching Stripe', async () => {
    const h = await makeHarness();
    const base = await serve(h);
    const { body, signature } = h.gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: 'pi_x' });
    expect((await post(`${base}/webhooks/stripe`, body)).status).toBe(400);
    expect((await post(`${base}/webhooks/stripe`, body, 'fake=deadbeef')).status).toBe(400);
    // Re-serialized JSON (same data, different bytes) fails: the signature covers the raw body.
    expect((await post(`${base}/webhooks/stripe`, JSON.stringify(JSON.parse(body), null, 2), signature)).status).toBe(400);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('bodies over 256kb are refused (413) before any signature work or Stripe call', async () => {
    const h = await makeHarness();
    const base = await serve(h);
    const response = await post(`${base}/webhooks/stripe`, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }), 't=1,v1=deadbeef');
    expect(response.status).toBe(413);
    const { body, signature } = h.gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: 'pi_x' });
    expect((await post(`${base}/webhooks/stripe`, body, signature)).status).not.toBe(413);
    expect(h.gateway.calls.filter((call) => call.method !== 'retrievePaymentIntent')).toHaveLength(0);
  });

  it('events are triggers: the PI is re-read from Stripe and the table applied', async () => {
    const h = await makeHarness();
    let triggers = 0;
    const base = await serve(h, () => {
      triggers += 1;
    });
    const quote = await h.quote();
    const result = await h.service.payWithSpt({ quoteId: quote.id, door: 'ucp', spt: 'spt_w', buyer: { email: 'a@example.com' } });
    if (!result.ok) throw new Error(result.message);
    const piId = result.value.stripe.paymentIntentId ?? '';
    // The owner captured from the Stripe Dashboard; the event body claims nothing we trust.
    h.gateway.setIntent(piId, { status: 'succeeded' });
    const event = h.gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: piId, metadata: { orderId: result.value.id } });
    const res = await post(`${base}/webhooks/stripe`, event.body, event.signature);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(h.gateway.callsOf('retrievePaymentIntent').length).toBeGreaterThan(0);
    expect(h.store.getOrder(result.value.id)?.status).toBe('paid');
    expect(triggers).toBe(1);

    // Replays are harmless (idempotent by construction).
    expect((await post(`${base}/webhooks/stripe`, event.body, event.signature)).status).toBe(200);
    expect(h.store.getOrder(result.value.id)?.status).toBe('paid');
  });

  it('checkout.session events drive link completion; unknown orders are a 200 no-op', async () => {
    const h = await makeHarness();
    const base = await serve(h);
    const quote = await h.quote();
    const link = await h.service.startLinkOrder(quote.id);
    if (!link.ok) throw new Error(link.message);
    const sessionId = h.store.getOrder(link.value.order.id)?.stripe.checkoutSessionId ?? '';
    h.gateway.payCheckoutSession(sessionId, { customer: { email: 'web@example.com' } });
    const event = h.gateway.webhookEvent({ type: 'checkout.session.completed', objectId: sessionId, metadata: { orderId: link.value.order.id } });
    expect((await post(`${base}/webhooks/stripe`, event.body, event.signature)).status).toBe(200);
    expect(h.store.getOrder(link.value.order.id)).toMatchObject({ status: 'awaiting_approval', buyer: { email: 'web@example.com' } });

    const before = h.gateway.calls.length;
    const unknown = h.gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: 'pi_zzz', metadata: { orderId: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect((await post(`${base}/webhooks/stripe`, unknown.body, unknown.signature)).status).toBe(200);
    expect(h.gateway.calls.length).toBe(before);
  });

  it('answers 500 (so Stripe retries) when Stripe cannot be re-read', async () => {
    const h = await makeHarness();
    const base = await serve(h);
    const quote = await h.quote();
    const result = await h.service.payWithSpt({ quoteId: quote.id, door: 'ucp', spt: 'spt_w', buyer: { email: 'a@example.com' } });
    if (!result.ok) throw new Error(result.message);
    h.gateway.failNext('retrievePaymentIntent', 'ambiguous');
    const event = h.gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: result.value.stripe.paymentIntentId ?? '', metadata: { orderId: result.value.id } });
    expect((await post(`${base}/webhooks/stripe`, event.body, event.signature)).status).toBe(500);
  });

  it('answers 500 while a refund of money a dead order must not keep is unresolved, 200 once done', async () => {
    const h = await makeHarness();
    const base = await serve(h);
    const quote = await h.quote();
    const result = await h.service.payWithSpt({ quoteId: quote.id, door: 'ucp', spt: 'spt_w', buyer: { email: 'a@example.com' } });
    if (!result.ok) throw new Error(result.message);
    const rejected = await h.service.reject(result.value.id);
    if (!rejected.ok) throw new Error(rejected.message);
    const piId = result.value.stripe.paymentIntentId ?? '';
    // Captured from the Dashboard after the owner rejected: must be refunded.
    h.gateway.setIntent(piId, { status: 'succeeded' });
    h.gateway.failNext('refund', 'ambiguous');
    const event = h.gateway.webhookEvent({ type: 'payment_intent.succeeded', objectId: piId, metadata: { orderId: result.value.id } });
    expect((await post(`${base}/webhooks/stripe`, event.body, event.signature)).status).toBe(500);
    expect(h.store.getOrder(result.value.id)?.releases).toHaveLength(1);
    // Stripe redelivers: the refund goes through and the webhook succeeds.
    expect((await post(`${base}/webhooks/stripe`, event.body, event.signature)).status).toBe(200);
    expect(h.gateway.intents.get(piId)?.amountRefunded).toBe(14600);
    expect(h.store.getOrder(result.value.id)?.releases).toBeUndefined();
  });
});
