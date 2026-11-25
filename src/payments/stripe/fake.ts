/**
 * FakeGateway — in-memory Stripe for tests (this module and the doors').
 *
 * - Behaves like Stripe where it matters: idempotency keys replay the first
 *   result, capture/cancel/refund/expire refuse unexpected states with a
 *   definitive error, search finds PIs by `metadata.orderId`.
 * - Scriptable: `authorizeStatus` / `nextAuthorize` shape new SPT
 *   authorizations; `failNext(method, mode)` injects `'ambiguous'` (throws
 *   before any effect), `'ambiguous_after'` (effect happens, then throws — the
 *   crash window) or a `DefinitiveGatewayError`.
 * - Customer actions: `payCheckoutSession`, `setIntent`.
 * - `calls` logs every method call in order.
 * - Every method yields to the event loop first so concurrent callers interleave.
 */
import { createHmac } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import type { ObservedCheckoutSession, ObservedPaymentIntent, Order, PaymentGateway, Buyer } from '../types.js';
import { AmbiguousGatewayError, DefinitiveGatewayError } from '../types.js';

export type GatewayMethod = Exclude<keyof PaymentGateway, 'verifyWebhook'>;
export type FailMode = 'ambiguous' | 'ambiguous_after' | DefinitiveGatewayError;

export interface GatewayCall {
  method: GatewayMethod;
  args: Record<string, unknown>;
}

export class FakeGateway implements PaymentGateway {
  readonly calls: GatewayCall[] = [];
  readonly intents = new Map<string, ObservedPaymentIntent>();
  readonly sessions = new Map<string, ObservedCheckoutSession>();
  /** Status of the PI a new SPT authorization creates. */
  authorizeStatus: ObservedPaymentIntent['status'] = 'requires_capture';
  /** Merged into the next newly created SPT PaymentIntent (e.g. a wrong amount), then cleared. */
  nextAuthorize: Partial<ObservedPaymentIntent> | undefined;
  /** `capture_before` reported on new authorizations. */
  captureBefore: string | undefined;
  readonly webhookSecret = 'whsec_fake_secret';

  private readonly failures = new Map<GatewayMethod, FailMode[]>();
  private readonly idempotency = new Map<string, string>();
  private readonly sessionOrders = new Map<string, { orderId: string; quoteId: string; amount: number; currency: string }>();
  private counter = 0;

  /** Queue a failure for the next `times` calls of `method`. */
  failNext(method: GatewayMethod, mode: FailMode, times = 1): void {
    const queue = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i++) queue.push(mode);
    this.failures.set(method, queue);
  }

  callsOf(method: GatewayMethod): GatewayCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Overwrite fields of a stored PaymentIntent (dashboard actions, hold lapse, …). */
  setIntent(id: string, patch: Partial<ObservedPaymentIntent>): ObservedPaymentIntent {
    const pi = this.intents.get(id);
    if (pi === undefined) throw new Error(`no fake intent ${id}`);
    const next = { ...pi, ...patch };
    this.intents.set(id, next);
    return { ...next };
  }

  /** Add an arbitrary PaymentIntent (e.g. a stray one for an order). */
  addIntent(pi: Omit<ObservedPaymentIntent, 'id'> & { id?: string }): ObservedPaymentIntent {
    const stored: ObservedPaymentIntent = { ...pi, id: pi.id ?? this.nextId('pi') };
    this.intents.set(stored.id, stored);
    return { ...stored };
  }

  /** The customer completes the hosted page: session → complete, PI held (manual capture). */
  payCheckoutSession(
    sessionId: string,
    options: { status?: ObservedPaymentIntent['status']; customer?: Buyer } = {},
  ): ObservedPaymentIntent {
    const session = this.sessions.get(sessionId);
    const binding = this.sessionOrders.get(sessionId);
    if (session === undefined || binding === undefined) throw new Error(`no fake session ${sessionId}`);
    const pi: ObservedPaymentIntent = {
      id: this.nextId('pi'),
      status: options.status ?? 'requires_capture',
      amount: binding.amount,
      currency: binding.currency,
      metadata: { orderId: binding.orderId, quoteId: binding.quoteId },
      ...(this.captureBefore !== undefined ? { captureBefore: this.captureBefore } : {}),
      amountRefunded: 0,
    };
    this.intents.set(pi.id, pi);
    this.sessions.set(sessionId, {
      ...session,
      status: 'complete',
      paymentIntentId: pi.id,
      ...(options.customer !== undefined ? { customer: options.customer } : {}),
    });
    return { ...pi };
  }

  /** Signature the fake `verifyWebhook` accepts for this raw body. */
  signWebhook(rawBody: string | Buffer): string {
    return `fake=${createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')}`;
  }

  /** Build a signed fake event body + signature. */
  webhookEvent(event: { type: string; objectId: string; metadata?: Record<string, string> }): { body: string; signature: string } {
    const body = JSON.stringify({ type: event.type, objectId: event.objectId, metadata: event.metadata ?? {} });
    return { body, signature: this.signWebhook(body) };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_fake_${String(this.counter).padStart(4, '0')}`;
  }

  /** Records the call; returns whether to throw ambiguous after the effect. */
  private async enter(method: GatewayMethod, args: Record<string, unknown>): Promise<boolean> {
    await tick();
    this.calls.push({ method, args });
    const mode = this.failures.get(method)?.shift();
    if (mode === undefined) return false;
    if (mode === 'ambiguous') throw new AmbiguousGatewayError(`fake ${method}: network timeout`);
    if (mode === 'ambiguous_after') return true;
    throw mode;
  }

  private intent(id: string): ObservedPaymentIntent {
    const pi = this.intents.get(id);
    if (pi === undefined) throw new DefinitiveGatewayError(`No such payment_intent: '${id}'`, 'resource_missing');
    return pi;
  }

  private static after<T>(throwAfter: boolean, value: T): T {
    if (throwAfter) throw new AmbiguousGatewayError('fake: connection reset after the request was processed');
    return value;
  }

  async authorizeSpt(input: { order: Order; spt: string; fingerprint: string; receiptEmail?: string }): Promise<ObservedPaymentIntent> {
    const { order } = input;
    const throwAfter = await this.enter('authorizeSpt', {
      orderId: order.id,
      spt: input.spt,
      fingerprint: input.fingerprint,
      receiptEmail: input.receiptEmail,
      amount: order.quote.totalCents,
      currency: order.quote.currency.toLowerCase(),
      captureMethod: 'manual',
    });
    const key = `scopegraph:${order.id}:authorize:${input.fingerprint}`;
    const existing = this.idempotency.get(key);
    if (existing !== undefined) return FakeGateway.after(throwAfter, { ...this.intent(existing) });
    const pi: ObservedPaymentIntent = {
      id: this.nextId('pi'),
      status: this.authorizeStatus,
      amount: order.quote.totalCents,
      currency: order.quote.currency.toLowerCase(),
      metadata: { orderId: order.id, quoteId: order.quoteId },
      ...(this.captureBefore !== undefined ? { captureBefore: this.captureBefore } : {}),
      amountRefunded: 0,
      ...this.nextAuthorize,
    };
    this.nextAuthorize = undefined;
    this.intents.set(pi.id, pi);
    this.idempotency.set(key, pi.id);
    return FakeGateway.after(throwAfter, { ...pi });
  }

  async createCheckoutSession(input: { order: Order; offeringName: string; successUrl: string; cancelUrl: string }): Promise<ObservedCheckoutSession> {
    const { order } = input;
    const throwAfter = await this.enter('createCheckoutSession', {
      orderId: order.id,
      offeringName: input.offeringName,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      amount: order.quote.totalCents,
      expiresAt: order.stripe.checkoutSessionExpiresAt,
    });
    const key = `scopegraph:${order.id}:checkout`;
    const existing = this.idempotency.get(key);
    if (existing !== undefined) {
      const replay = this.sessions.get(existing);
      if (replay !== undefined) return FakeGateway.after(throwAfter, { ...replay });
    }
    const expiresAt = order.stripe.checkoutSessionExpiresAt;
    if (expiresAt === undefined) throw new DefinitiveGatewayError('expires_at is required', 'parameter_missing');
    const id = this.nextId('cs');
    const session: ObservedCheckoutSession = {
      id,
      status: 'open',
      url: `https://checkout.stripe.test/c/pay/${id}`,
      expiresAt,
      metadata: { orderId: order.id },
    };
    this.sessions.set(id, session);
    this.sessionOrders.set(id, {
      orderId: order.id,
      quoteId: order.quoteId,
      amount: order.quote.totalCents,
      currency: order.quote.currency.toLowerCase(),
    });
    this.idempotency.set(key, id);
    return FakeGateway.after(throwAfter, { ...session });
  }

  async capture(order: Order, paymentIntentId: string): Promise<void> {
    const throwAfter = await this.enter('capture', { orderId: order.id, paymentIntentId, amountToCapture: order.quote.totalCents });
    const pi = this.intent(paymentIntentId);
    if (pi.status !== 'requires_capture') {
      throw new DefinitiveGatewayError(`This PaymentIntent could not be captured because it has a status of ${pi.status}.`, 'payment_intent_unexpected_state');
    }
    this.intents.set(pi.id, { ...pi, status: 'succeeded' });
    FakeGateway.after(throwAfter, undefined);
  }

  async cancel(order: Order, paymentIntentId: string): Promise<void> {
    const throwAfter = await this.enter('cancel', { orderId: order.id, paymentIntentId });
    const pi = this.intent(paymentIntentId);
    if (pi.status === 'succeeded' || pi.status === 'canceled') {
      throw new DefinitiveGatewayError(`You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`, 'payment_intent_unexpected_state');
    }
    this.intents.set(pi.id, { ...pi, status: 'canceled' });
    FakeGateway.after(throwAfter, undefined);
  }

  async refund(order: Order, paymentIntentId: string): Promise<void> {
    const throwAfter = await this.enter('refund', { orderId: order.id, paymentIntentId, idempotencyKey: `scopegraph:${order.id}:refund:${paymentIntentId}` });
    const pi = this.intent(paymentIntentId);
    if (pi.status !== 'succeeded') throw new DefinitiveGatewayError('This PaymentIntent has no successful charge to refund.', 'charge_not_refundable');
    this.intents.set(pi.id, { ...pi, amountRefunded: pi.amount });
    FakeGateway.after(throwAfter, undefined);
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<ObservedPaymentIntent> {
    const throwAfter = await this.enter('retrievePaymentIntent', { paymentIntentId });
    return FakeGateway.after(throwAfter, { ...this.intent(paymentIntentId) });
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ObservedCheckoutSession> {
    const throwAfter = await this.enter('retrieveCheckoutSession', { sessionId });
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new DefinitiveGatewayError(`No such checkout.session: '${sessionId}'`, 'resource_missing');
    return FakeGateway.after(throwAfter, { ...session });
  }

  async expireCheckoutSession(sessionId: string): Promise<void> {
    const throwAfter = await this.enter('expireCheckoutSession', { sessionId });
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new DefinitiveGatewayError(`No such checkout.session: '${sessionId}'`, 'resource_missing');
    if (session.status !== 'open') {
      throw new DefinitiveGatewayError(`Only Checkout Sessions with a status of open can be expired (status: ${session.status}).`, 'checkout_session_unexpected_state');
    }
    this.sessions.set(sessionId, { ...session, status: 'expired' });
    FakeGateway.after(throwAfter, undefined);
  }

  async findPaymentIntentsByOrder(orderId: string): Promise<ObservedPaymentIntent[]> {
    const throwAfter = await this.enter('findPaymentIntentsByOrder', { orderId });
    const found = [...this.intents.values()].filter((pi) => pi.metadata['orderId'] === orderId).map((pi) => ({ ...pi }));
    return FakeGateway.after(throwAfter, found);
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): { type: string; objectId: string; metadata: Record<string, string> } | undefined {
    if (signature === undefined || signature !== this.signWebhook(rawBody)) return undefined;
    const parsed = JSON.parse(rawBody.toString('utf8')) as { type: string; objectId: string; metadata: Record<string, string> };
    return { type: parsed.type, objectId: parsed.objectId, metadata: parsed.metadata };
  }
}
