/**
 * StripeGateway — the only code that talks to Stripe. Returns observations;
 * the order service decides what they mean. Errors are classified:
 * network/5xx/rate-limit/idempotency-in-flight ⇒ `AmbiguousGatewayError`
 * (outcome unknown, caller re-observes later); everything else ⇒
 * `DefinitiveGatewayError` with a scrubbed message.
 */
import type Stripe from 'stripe';
import type {
  Buyer,
  ObservedCheckoutSession,
  ObservedPaymentIntent,
  Order,
  PaymentGateway,
  PaymentsConfig,
} from '../types.js';
import { AmbiguousGatewayError, DefinitiveGatewayError } from '../types.js';
import { redactStripeSecrets } from './scrub.js';
import { STRIPE_SPT_API_VERSION } from './versions.js';

const PI_STATUSES: Record<ObservedPaymentIntent['status'], true> = {
  requires_payment_method: true,
  requires_confirmation: true,
  requires_action: true,
  processing: true,
  requires_capture: true,
  canceled: true,
  succeeded: true,
};

/** Compact human summary of the frozen quote lines (Checkout product description). */
function quoteLineSummary(order: Order): string {
  const text = order.quote.lines
    .map((line) => (line.quantity !== undefined && line.quantity !== 1 ? `${line.label} ×${String(line.quantity)}` : line.label))
    .join('; ');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** Stripe SDK error types whose outcome is unknown (the request may still have landed). */
const AMBIGUOUS_STRIPE_ERRORS: Record<string, true> = {
  StripeConnectionError: true,
  StripeAPIError: true,
  StripeRateLimitError: true,
  StripeIdempotencyError: true,
};

/**
 * Stripe SDK errors are recognized by their `type` (`StripeCardError`, …),
 * not `instanceof`: the SDK is only loaded when a gateway is created.
 */
function isStripeError(err: unknown): err is Error & { type: string; statusCode?: number; code?: string } {
  return err instanceof Error && 'type' in err && typeof err.type === 'string' && err.type.startsWith('Stripe');
}

export function classifyStripeError(err: unknown): AmbiguousGatewayError | DefinitiveGatewayError {
  if (err instanceof AmbiguousGatewayError || err instanceof DefinitiveGatewayError) return err;
  if (isStripeError(err)) {
    const message = redactStripeSecrets(err.message) ?? 'Stripe error';
    const ambiguous = AMBIGUOUS_STRIPE_ERRORS[err.type] === true
      || (err.statusCode !== undefined && err.statusCode >= 500);
    return ambiguous ? new AmbiguousGatewayError(message) : new DefinitiveGatewayError(message, err.code);
  }
  const message = err instanceof Error ? redactStripeSecrets(err.message) : undefined;
  return new AmbiguousGatewayError(message ?? 'Unknown Stripe failure');
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyStripeError(err);
  }
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function observePaymentIntent(pi: Stripe.PaymentIntent): ObservedPaymentIntent {
  const charge = typeof pi.latest_charge === 'object' && pi.latest_charge !== null ? pi.latest_charge : undefined;
  const captureBefore = charge?.payment_method_details?.card?.capture_before;
  return {
    id: pi.id,
    status: Object.hasOwn(PI_STATUSES, pi.status) ? (pi.status as ObservedPaymentIntent['status']) : 'processing',
    amount: pi.amount,
    currency: pi.currency,
    metadata: { ...pi.metadata },
    ...(captureBefore !== undefined ? { captureBefore: toIso(captureBefore) } : {}),
    amountRefunded: charge?.amount_refunded ?? 0,
  };
}

function observeCheckoutSession(session: Stripe.Checkout.Session): ObservedCheckoutSession {
  const details = session.customer_details;
  const customer: Buyer = {
    ...(details?.name ? { name: details.name } : {}),
    ...(details?.email ? { email: details.email } : {}),
    ...(details?.phone ? { phone: details.phone } : {}),
  };
  const pi = session.payment_intent;
  return {
    id: session.id,
    status: session.status === 'complete' ? 'complete' : session.status === 'expired' ? 'expired' : 'open',
    ...(pi !== null ? { paymentIntentId: typeof pi === 'string' ? pi : pi.id } : {}),
    ...(session.url !== null ? { url: session.url } : {}),
    expiresAt: toIso(session.expires_at),
    metadata: { ...session.metadata },
    ...(Object.keys(customer).length > 0 ? { customer } : {}),
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function readMetadata(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || !('metadata' in value)) return {};
  const metadata: unknown = value.metadata;
  if (typeof metadata !== 'object' || metadata === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) if (typeof v === 'string') out[k] = v;
  return out;
}

export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  /**
   * A gateway on the real SDK. The SDK is imported here, not at module load:
   * it has import-time side effects that commands and servers without
   * payments must not pay.
   */
  static async create(config: PaymentsConfig['stripe']): Promise<StripeGateway> {
    const { default: StripeSdk } = await import('stripe');
    return new StripeGateway(config, new StripeSdk(config.secretKey, { maxNetworkRetries: 2 }));
  }

  constructor(config: PaymentsConfig['stripe'], client: Stripe) {
    this.stripe = client;
    this.webhookSecret = config.webhookSecret;
  }

  async authorizeSpt(input: { order: Order; spt: string; fingerprint: string; receiptEmail?: string }): Promise<ObservedPaymentIntent> {
    const { order } = input;
    // The SDK types don't expose the preview `shared_payment_granted_token`
    // field on PaymentMethodData; the wire format is documented by Stripe.
    const paymentMethodData = {
      shared_payment_granted_token: input.spt,
    } as unknown as Stripe.PaymentIntentCreateParams.PaymentMethodData;
    const pi = await call(() =>
      this.stripe.paymentIntents.create(
        {
          amount: order.quote.totalCents,
          currency: order.quote.currency.toLowerCase(),
          payment_method_data: paymentMethodData,
          confirm: true,
          capture_method: 'manual',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { orderId: order.id, quoteId: order.quoteId },
          ...(input.receiptEmail !== undefined ? { receipt_email: input.receiptEmail } : {}),
          expand: ['latest_charge'],
        },
        {
          idempotencyKey: `scopegraph:${order.id}:authorize:${input.fingerprint}`,
          apiVersion: STRIPE_SPT_API_VERSION,
        },
      ),
    );
    return observePaymentIntent(pi);
  }

  async createCheckoutSession(input: { order: Order; offeringName: string; successUrl: string; cancelUrl: string }): Promise<ObservedCheckoutSession> {
    const { order } = input;
    const expiresAt = order.stripe.checkoutSessionExpiresAt;
    if (expiresAt === undefined) throw new DefinitiveGatewayError('checkout session expiry must be persisted before the call');
    const description = quoteLineSummary(order);
    const session = await call(() =>
      this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: order.quote.currency.toLowerCase(),
                unit_amount: order.quote.totalCents,
                product_data: { name: input.offeringName, ...(description !== '' ? { description } : {}) },
              },
              quantity: 1,
            },
          ],
          // API 2026-11-18 replaced `payment_method_types` with this filter; card only.
          allowed_payment_method_types: ['card'],
          payment_intent_data: { capture_method: 'manual', metadata: { orderId: order.id, quoteId: order.quoteId } },
          client_reference_id: order.id,
          metadata: { orderId: order.id },
          customer_creation: 'if_required',
          expires_at: Math.floor(Date.parse(expiresAt) / 1000),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: `scopegraph:${order.id}:checkout` },
      ),
    );
    return observeCheckoutSession(session);
  }

  async capture(order: Order, paymentIntentId: string): Promise<void> {
    await call(() => this.stripe.paymentIntents.capture(paymentIntentId, { amount_to_capture: order.quote.totalCents }));
  }

  async cancel(_order: Order, paymentIntentId: string): Promise<void> {
    await call(() => this.stripe.paymentIntents.cancel(paymentIntentId));
  }

  async refund(order: Order, paymentIntentId: string): Promise<void> {
    await call(() =>
      this.stripe.refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey: `scopegraph:${order.id}:refund:${paymentIntentId}` },
      ),
    );
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<ObservedPaymentIntent> {
    return observePaymentIntent(
      await call(() => this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] })),
    );
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ObservedCheckoutSession> {
    return observeCheckoutSession(await call(() => this.stripe.checkout.sessions.retrieve(sessionId)));
  }

  async expireCheckoutSession(sessionId: string): Promise<void> {
    await call(() => this.stripe.checkout.sessions.expire(sessionId));
  }

  async findPaymentIntentsByOrder(orderId: string): Promise<ObservedPaymentIntent[]> {
    // Order ids are `ord_` + base32 (validated by callers), so no quoting issues.
    const result = await call(() =>
      this.stripe.paymentIntents.search({
        query: `metadata['orderId']:'${orderId}'`,
        expand: ['data.latest_charge'],
      }),
    );
    return result.data.map(observePaymentIntent);
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): { type: string; objectId: string; metadata: Record<string, string> } | undefined {
    if (signature === undefined || signature === '') return undefined;
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      return undefined;
    }
    const object: unknown = event.data.object;
    // Charge events (charge.refunded) are re-read through their PaymentIntent.
    const objectId = event.type.startsWith('charge.') ? readString(object, 'payment_intent') : readString(object, 'id');
    if (objectId === undefined) return undefined;
    return { type: event.type, objectId, metadata: readMetadata(object) };
  }
}
