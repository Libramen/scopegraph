import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import type { Order } from '../types.js';
import { AmbiguousGatewayError, DefinitiveGatewayError } from '../types.js';
import { FakeGateway, STRIPE_SPT_API_VERSION, StripeGateway, classifyStripeError, redactStripeSecrets } from './index.js';

const ORDER: Order = {
  id: 'ord_aaaaaaaaaaaaaaaaaaaaaaaa',
  quoteId: 'qt_bbbbbbbbbbbbbbbbbbbbbbbb',
  offering: 'lesson',
  request: { answers: {}, selections: {} },
  quote: {
    currency: 'USD',
    lines: [
      { id: 'l1', label: 'Surf lesson', kind: 'base', amountCents: 14600, quantity: 2, unitAmountCents: 7300, taxable: true, source: { offering: 'lesson' } },
      { id: 'l2', label: 'Wetsuit', kind: 'addon', amountCents: 1000, taxable: true, source: { offering: 'lesson' } },
    ],
    subtotalCents: 15600,
    taxCents: 0,
    totalCents: 15600,
  },
  confirmation: 'owner_approves',
  door: 'ucp',
  createdAt: '2026-07-01T00:00:00.000Z',
  stripe: { checkoutSessionExpiresAt: '2026-07-01T00:31:00.000Z' },
  status: 'authorizing',
  pendingHooks: [],
  version: 0,
};

interface Captured {
  method: string;
  params: unknown;
  options: unknown;
}

function piObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pi_123',
    status: 'requires_capture',
    amount: 15600,
    currency: 'usd',
    metadata: { orderId: ORDER.id, quoteId: ORDER.quoteId },
    latest_charge: { amount_refunded: 0, payment_method_details: { card: { capture_before: 1_783_000_000 } } },
    ...overrides,
  };
}

/** Minimal Stripe client double recording every call. */
function stubClient(): { client: Stripe; calls: Captured[] } {
  const calls: Captured[] = [];
  const record = (method: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ method, params: args[1] === undefined || typeof args[0] !== 'string' ? args[0] : args[1], options: typeof args[0] === 'string' ? args[2] : args[1] });
    return result;
  };
  const client = {
    paymentIntents: {
      create: record('paymentIntents.create', piObject()),
      capture: record('paymentIntents.capture', piObject({ status: 'succeeded' })),
      cancel: record('paymentIntents.cancel', piObject({ status: 'canceled' })),
      retrieve: record('paymentIntents.retrieve', piObject()),
      search: record('paymentIntents.search', { data: [piObject()] }),
    },
    refunds: { create: record('refunds.create', { id: 're_1' }) },
    checkout: {
      sessions: {
        create: record('checkout.sessions.create', {
          id: 'cs_test_1',
          status: 'open',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          expires_at: 1_782_865_860,
          metadata: { orderId: ORDER.id },
          payment_intent: null,
          customer_details: null,
        }),
        retrieve: record('checkout.sessions.retrieve', {
          id: 'cs_test_1',
          status: 'complete',
          url: null,
          expires_at: 1_782_865_860,
          metadata: { orderId: ORDER.id },
          payment_intent: 'pi_123',
          customer_details: { name: 'Ada', email: 'ada@example.com', phone: null },
        }),
        expire: record('checkout.sessions.expire', {}),
      },
    },
  };
  return { client: client as unknown as Stripe, calls };
}

describe('redactStripeSecrets', () => {
  it('redacts SPTs, payment methods, keys and secrets but keeps PI ids', () => {
    const input = 'Rejected spt_live_9QxT_77 via pm_1NzA2b, keys rk_live_Q9 and sk_test_m4K, secret whsec_A1b2, endpoint we_9Z, seti_44 and src_5 for profile_ABCDEFGHIJKLMNOP99 (pi_42 kept; profile_photo kept)';
    expect(redactStripeSecrets(input)).toBe(
      'Rejected spt_[REDACTED] via pm_[REDACTED], keys rk_[REDACTED] and sk_[REDACTED], secret whsec_[REDACTED], endpoint we_[REDACTED], seti_[REDACTED] and src_[REDACTED] for profile_[REDACTED] (pi_42 kept; profile_photo kept)',
    );
    expect(redactStripeSecrets(undefined)).toBeUndefined();
    expect(redactStripeSecrets('')).toBe('');
  });

  it('redacts account, card-token, customer and ephemeral-key ids and PaymentIntent client secrets in Stripe errors', () => {
    const cases: Array<[string, string]> = [
      [
        "The provided key 'sk_live_********************wxyz' does not have access to account 'acct_1NzA2bLkdIwHu7ix' (or that account does not exist). Application access may have been revoked.",
        "The provided key 'sk_live_********************wxyz' does not have access to account 'acct_[REDACTED]' (or that account does not exist). Application access may have been revoked.",
      ],
      [
        "You cannot use a Stripe token more than once: tok_1NzA2bLkdIwHu7ixQ8aR3tPa.",
        'You cannot use a Stripe token more than once: tok_[REDACTED].',
      ],
      [
        "No such customer: 'cus_PqR5tUvWxYz012'",
        "No such customer: 'cus_[REDACTED]'",
      ],
      [
        'Ephemeral key ek_live_YWNjdF8xTnpBMmJMa2RJd0h1N2l4LGZ3 has expired.',
        'Ephemeral key ek_[REDACTED] has expired.',
      ],
      [
        "The client_secret provided does not match any associated PaymentIntent on this account: 'pi_3MtwBwLkdIwHu7ix28a3tqPa_secret_YrKJUKribcBjcG8HVhfZluoGH'. Retrieve pi_3MtwBwLkdIwHu7ix28a3tqPa instead.",
        "The client_secret provided does not match any associated PaymentIntent on this account: 'pi_3MtwBwLkdIwHu7ix28a3tqPa_secret_[REDACTED]'. Retrieve pi_3MtwBwLkdIwHu7ix28a3tqPa instead.",
      ],
    ];
    for (const [input, expected] of cases) expect(redactStripeSecrets(input)).toBe(expected);
  });
});

describe('StripeGateway', () => {
  it('authorizeSpt: exact PI params, pinned SPT version, fingerprinted idempotency key', async () => {
    const { client, calls } = stubClient();
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', livemode: false }, client);
    const observed = await gateway.authorizeSpt({ order: ORDER, spt: 'spt_live_token', fingerprint: 'Fp-'.repeat(8), receiptEmail: 'ada@example.com' });
    expect(calls[0]).toEqual({
      method: 'paymentIntents.create',
      params: {
        amount: 15600,
        currency: 'usd',
        payment_method_data: { shared_payment_granted_token: 'spt_live_token' },
        confirm: true,
        capture_method: 'manual',
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { orderId: ORDER.id, quoteId: ORDER.quoteId },
        receipt_email: 'ada@example.com',
        expand: ['latest_charge'],
      },
      options: { idempotencyKey: `scopegraph:${ORDER.id}:authorize:${'Fp-'.repeat(8)}`, apiVersion: STRIPE_SPT_API_VERSION },
    });
    expect(observed).toEqual({
      id: 'pi_123',
      status: 'requires_capture',
      amount: 15600,
      currency: 'usd',
      metadata: { orderId: ORDER.id, quoteId: ORDER.quoteId },
      captureBefore: new Date(1_783_000_000 * 1000).toISOString(),
      amountRefunded: 0,
    });
    expect(STRIPE_SPT_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.preview$/);
  });

  it('createCheckoutSession: manual-capture card session with the persisted expiry', async () => {
    const { client, calls } = stubClient();
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', livemode: false }, client);
    const session = await gateway.createCheckoutSession({ order: ORDER, offeringName: 'Surf Lesson', successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    expect(calls[0]).toEqual({
      method: 'checkout.sessions.create',
      params: {
        mode: 'payment',
        line_items: [{
          price_data: { currency: 'usd', unit_amount: 15600, product_data: { name: 'Surf Lesson', description: 'Surf lesson ×2; Wetsuit' } },
          quantity: 1,
        }],
        allowed_payment_method_types: ['card'],
        payment_intent_data: { capture_method: 'manual', metadata: { orderId: ORDER.id, quoteId: ORDER.quoteId } },
        client_reference_id: ORDER.id,
        metadata: { orderId: ORDER.id },
        customer_creation: 'if_required',
        expires_at: Math.floor(Date.parse('2026-07-01T00:31:00.000Z') / 1000),
        success_url: 'https://x/s',
        cancel_url: 'https://x/c',
      },
      options: { idempotencyKey: `scopegraph:${ORDER.id}:checkout` },
    });
    expect(session).toMatchObject({ id: 'cs_test_1', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    await expect(gateway.createCheckoutSession({ order: { ...ORDER, stripe: {} }, offeringName: 'x', successUrl: 'x', cancelUrl: 'x' }))
      .rejects.toBeInstanceOf(DefinitiveGatewayError);
  });

  it('capture/cancel/refund/retrieve/search/expire use the documented calls', async () => {
    const { client, calls } = stubClient();
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', livemode: false }, client);
    await gateway.capture(ORDER, 'pi_123');
    await gateway.cancel(ORDER, 'pi_123');
    await gateway.refund(ORDER, 'pi_123');
    await gateway.retrievePaymentIntent('pi_123');
    const found = await gateway.findPaymentIntentsByOrder(ORDER.id);
    const session = await gateway.retrieveCheckoutSession('cs_test_1');
    await gateway.expireCheckoutSession('cs_test_1');
    expect(calls.map((c) => c.method)).toEqual([
      'paymentIntents.capture',
      'paymentIntents.cancel',
      'refunds.create',
      'paymentIntents.retrieve',
      'paymentIntents.search',
      'checkout.sessions.retrieve',
      'checkout.sessions.expire',
    ]);
    expect(calls[0]?.params).toEqual({ amount_to_capture: 15600 });
    expect(calls[2]).toMatchObject({ params: { payment_intent: 'pi_123' }, options: { idempotencyKey: `scopegraph:${ORDER.id}:refund:pi_123` } });
    expect(calls[3]?.params).toEqual({ expand: ['latest_charge'] });
    expect(calls[4]?.params).toEqual({ query: `metadata['orderId']:'${ORDER.id}'`, expand: ['data.latest_charge'] });
    expect(found).toHaveLength(1);
    expect(session).toMatchObject({ status: 'complete', paymentIntentId: 'pi_123', customer: { name: 'Ada', email: 'ada@example.com' } });
  });

  it('classifies errors: network/5xx/rate-limit ambiguous, card/invalid definitive (scrubbed)', () => {
    const conn = classifyStripeError(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }));
    expect(conn).toBeInstanceOf(AmbiguousGatewayError);
    expect(classifyStripeError(new Stripe.errors.StripeAPIError({ message: 'oops' }))).toBeInstanceOf(AmbiguousGatewayError);
    expect(classifyStripeError(new Stripe.errors.StripeRateLimitError({ message: 'slow down' }))).toBeInstanceOf(AmbiguousGatewayError);
    expect(classifyStripeError(new Error('ETIMEDOUT'))).toBeInstanceOf(AmbiguousGatewayError);
    const card = classifyStripeError(new Stripe.errors.StripeCardError({ message: 'Declined for spt_test_abc', code: 'card_declined', type: 'card_error' }));
    expect(card).toBeInstanceOf(DefinitiveGatewayError);
    expect(card.message).toBe('Declined for spt_[REDACTED]');
    expect(card instanceof DefinitiveGatewayError ? card.code : undefined).toBe('card_declined');
    expect(classifyStripeError(new Stripe.errors.StripeInvalidRequestError({ message: 'bad', code: 'payment_intent_unexpected_state', type: 'invalid_request_error' })))
      .toBeInstanceOf(DefinitiveGatewayError);
  });

  it('a thrown SDK error surfaces as a classified gateway error', async () => {
    const client = {
      paymentIntents: {
        capture: async () => {
          throw new Stripe.errors.StripeConnectionError({ message: 'reset' });
        },
      },
    } as unknown as Stripe;
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', livemode: false }, client);
    await expect(gateway.capture(ORDER, 'pi_1')).rejects.toBeInstanceOf(AmbiguousGatewayError);
  });

  it('verifies webhook signatures on the raw body; extracts trigger fields', () => {
    const secret = 'whsec_test_secret';
    const helper = new Stripe('sk_test_x');
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', webhookSecret: secret, livemode: false }, helper);
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', object: 'payment_intent', metadata: { orderId: ORDER.id } } },
    });
    const header = helper.webhooks.generateTestHeaderString({ payload, secret });
    expect(gateway.verifyWebhook(Buffer.from(payload), header)).toEqual({
      type: 'payment_intent.succeeded',
      objectId: 'pi_123',
      metadata: { orderId: ORDER.id },
    });
    expect(gateway.verifyWebhook(Buffer.from(payload.replace('pi_123', 'pi_999')), header)).toBeUndefined();
    expect(gateway.verifyWebhook(Buffer.from(payload), undefined)).toBeUndefined();
    const wrong = helper.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });
    expect(gateway.verifyWebhook(Buffer.from(payload), wrong)).toBeUndefined();

    const charge = JSON.stringify({
      id: 'evt_2',
      object: 'event',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_123', metadata: {} } },
    });
    expect(gateway.verifyWebhook(Buffer.from(charge), helper.webhooks.generateTestHeaderString({ payload: charge, secret })))
      .toEqual({ type: 'charge.refunded', objectId: 'pi_123', metadata: {} });
  });
});

describe('FakeGateway', () => {
  it('replays idempotent authorizations and refuses unexpected states', async () => {
    const fake = new FakeGateway();
    const first = await fake.authorizeSpt({ order: ORDER, spt: 'spt_a', fingerprint: 'fp' });
    const again = await fake.authorizeSpt({ order: ORDER, spt: 'spt_a', fingerprint: 'fp' });
    expect(again.id).toBe(first.id);
    await fake.capture(ORDER, first.id);
    await expect(fake.capture(ORDER, first.id)).rejects.toBeInstanceOf(DefinitiveGatewayError);
    await expect(fake.cancel(ORDER, first.id)).rejects.toBeInstanceOf(DefinitiveGatewayError);
    fake.failNext('retrievePaymentIntent', 'ambiguous');
    await expect(fake.retrievePaymentIntent(first.id)).rejects.toBeInstanceOf(AmbiguousGatewayError);
    expect((await fake.retrievePaymentIntent(first.id)).status).toBe('succeeded');
    const { body, signature } = fake.webhookEvent({ type: 'payment_intent.succeeded', objectId: first.id });
    expect(fake.verifyWebhook(Buffer.from(body), signature)).toMatchObject({ objectId: first.id });
    expect(fake.verifyWebhook(Buffer.from(body), 'fake=bad')).toBeUndefined();
  });
});
