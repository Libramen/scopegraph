/**
 * Stripe triggers and the reconciler sweep — the two ways the service learns
 * about Stripe without a caller in the loop: webhook events
 * (`handleStripeTrigger`) and the periodic `reconcile` pass (processing states,
 * link session expiry, approval deadlines, release retries, hooks, pruning).
 *
 * Invariants that live here:
 * - Events are triggers only: the PI / session is re-read from Stripe and the
 *   observation table applied (`settle` / `applySession`) under the order lock.
 *   Unknown or pruned orders are a no-op; no dedupe store is needed.
 * - A webhook throws (→ 500, Stripe redelivers) while a release of money the
 *   order must not keep is unresolved and not given up.
 * - Processing states are only re-driven after the 2-minute grace; an
 *   `authorizing` order without a PI id is found by metadata search and fails
 *   only 24h after the attempt.
 * - Past the approval deadline the hold is voided (`expired`), never captured.
 * - Due releases are retried here (and only these retries count toward the cap).
 * - Hooks are kicked, never awaited: a hung hook can't stall the sweep.
 */
import type { ObservedCheckoutSession, ObservedPaymentIntent, Order } from '../types.js';
import { DefinitiveGatewayError } from '../types.js';
import type { OrderCore } from './core.js';
import { errorText, PROCESSING_GRACE_MS } from './core.js';
import { createLinkSession } from './funnel.js';
import { MAX_RELEASE_ATTEMPTS, releaseAttemptFailed, releasePending } from './releases.js';
import { applySession, settle, voidOrder } from './settle.js';

const AUTHORIZE_SEARCH_WINDOW_MS = 24 * 3_600_000;

// ── Webhook triggers ─────────────────────────────────────────────────────────

export async function handleStripeTrigger(core: OrderCore, event: { type: string; objectId: string; metadata: Record<string, string> }): Promise<void> {
  const hinted = event.metadata['orderId'];
  if (hinted !== undefined && core.store.getOrder(hinted) === undefined) return; // not ours / pruned: no-op

  if (event.objectId.startsWith('cs_')) {
    let session: ObservedCheckoutSession;
    try {
      session = await core.gateway.retrieveCheckoutSession(event.objectId);
    } catch (err) {
      if (err instanceof DefinitiveGatewayError) return;
      throw err;
    }
    const orderId = session.metadata['orderId'];
    if (orderId === undefined || core.store.getOrder(orderId) === undefined) return;
    await core.withOrderLock(orderId, async () => {
      const order = core.store.getOrder(orderId);
      if (order !== undefined) await applySession(core, order, session, `webhook:${event.type}`);
    });
    core.hooks.kick(orderId);
    throwIfReleasePending(core, orderId, session.paymentIntentId);
    return;
  }

  let pi: ObservedPaymentIntent;
  try {
    pi = await core.gateway.retrievePaymentIntent(event.objectId);
  } catch (err) {
    if (err instanceof DefinitiveGatewayError) return;
    throw err;
  }
  const orderId = pi.metadata['orderId'];
  if (orderId === undefined || core.store.getOrder(orderId) === undefined) return;
  await core.withOrderLock(orderId, async () => {
    const order = core.store.getOrder(orderId);
    if (order !== undefined) await settle(core, order, pi, { op: `webhook:${event.type}` });
  });
  core.hooks.kick(orderId);
  throwIfReleasePending(core, orderId, pi.id);
}

/** Webhook → 500 while money we must give back is still held, so Stripe redelivers. */
function throwIfReleasePending(core: OrderCore, orderId: string, paymentIntentId: string | undefined): void {
  if (releasePending(core, orderId, paymentIntentId)) {
    throw new Error(`release of ${paymentIntentId ?? ''} for order ${orderId} is unresolved`);
  }
}

// ── The sweep ────────────────────────────────────────────────────────────────

export async function reconcile(core: OrderCore, now?: Date): Promise<void> {
  const at = (now ?? core.now()).getTime();
  for (const snapshot of core.store.listOrders()) {
    try {
      await reconcileOrder(core, snapshot, at);
      if ((snapshot.releases?.length ?? 0) > 0) await retryReleases(core, snapshot.id, at);
    } catch (err) {
      core.log(`reconcile of ${snapshot.id} failed: ${errorText(err)}`);
    }
    // Never awaited: a slow or hung hook must not hold up deadlines, captures or pruning.
    core.hooks.kick(snapshot.id);
  }
  await core.store.prune(new Date(at));
}

/** Re-drive every due, not-given-up release on an order (any status, terminal included). */
async function retryReleases(core: OrderCore, orderId: string, at: number): Promise<void> {
  await core.withOrderLock(orderId, async () => {
    const due = (core.store.getOrder(orderId)?.releases ?? [])
      .filter((r) => r.attempts < MAX_RELEASE_ATTEMPTS && at >= Date.parse(r.nextAttemptAt));
    for (const entry of due) {
      const order = core.store.getOrder(orderId);
      if (order === undefined) return;
      const pi = await core.observe(entry.paymentIntentId);
      const after = pi === undefined ? order : await settle(core, order, pi, { op: 'reconcile_release', releaseRetry: true });
      // Still tracked (failed, unobservable, or a state Stripe can't act on yet): one counted attempt.
      if (after.releases?.some((r) => r.paymentIntentId === entry.paymentIntentId) === true) {
        await releaseAttemptFailed(core, after, entry.paymentIntentId, 'reconcile_release');
      }
    }
  });
}

async function reconcileOrder(core: OrderCore, snapshot: Order, at: number): Promise<void> {
  const age = at - Date.parse(snapshot.lastOperation?.at ?? snapshot.createdAt);
  switch (snapshot.status) {
    case 'authorizing':
    case 'capturing':
    case 'voiding':
      if (age < PROCESSING_GRACE_MS) return;
      await core.withOrderLock(snapshot.id, async () => {
        const order = core.store.getOrder(snapshot.id);
        if (order === undefined || order.status !== snapshot.status) return;
        await reconcileProcessing(core, order, at);
      });
      return;
    case 'awaiting_payment':
      await core.withOrderLock(snapshot.id, async () => {
        const order = core.store.getOrder(snapshot.id);
        if (order === undefined || order.status !== 'awaiting_payment') return;
        await reconcileLink(core, order, at, age);
      });
      return;
    case 'awaiting_approval':
      if (snapshot.approvalDeadline === undefined || at < Date.parse(snapshot.approvalDeadline)) return;
      await core.withOrderLock(snapshot.id, async () => {
        const order = core.store.getOrder(snapshot.id);
        if (order === undefined || order.status !== 'awaiting_approval') return;
        await voidOrder(core, order, 'reconcile', 'expired', 'approval_deadline_passed');
      });
      return;
    default:
      return;
  }
}

async function reconcileProcessing(core: OrderCore, order: Order, at: number): Promise<void> {
  const bound = order.stripe.paymentIntentId;
  if (bound !== undefined) {
    const pi = await core.observe(bound);
    if (pi !== undefined) await settle(core, order, pi, { op: 'reconcile' });
    return;
  }
  if (order.status !== 'authorizing') return;
  // Crash/timeout between the durable `authorizing` write and Stripe's answer: find the PI by metadata.
  let found: ObservedPaymentIntent[];
  try {
    found = await core.gateway.findPaymentIntentsByOrder(order.id);
  } catch (err) {
    core.log(`PaymentIntent search for ${order.id} failed: ${errorText(err)}`);
    return;
  }
  const ours = found.filter((pi) => pi.metadata['orderId'] === order.id);
  const best = ours.find((pi) => pi.status === 'succeeded' || pi.status === 'requires_capture') ?? ours[0];
  if (best === undefined) {
    const attemptAt = Date.parse(order.stripe.authorizeAttemptAt ?? order.createdAt);
    if (at - attemptAt >= AUTHORIZE_SEARCH_WINDOW_MS) {
      await core.commit(order, 'reconcile', { status: 'payment_failed', reason: 'authorization_not_found' });
    }
    return;
  }
  let current = await settle(core, order, best, { op: 'reconcile' });
  for (const other of ours) {
    if (other.id !== best.id) current = await settle(core, current, other, { op: 'reconcile' });
  }
}

async function reconcileLink(core: OrderCore, order: Order, at: number, age: number): Promise<void> {
  const sessionId = order.stripe.checkoutSessionId;
  if (sessionId === undefined) {
    // Session create was ambiguous: replay it (same key) to learn its id.
    if (age >= PROCESSING_GRACE_MS) await createLinkSession(core, order, 'reconcile');
    return;
  }
  if (order.stripe.checkoutSessionExpiresAt === undefined || at < Date.parse(order.stripe.checkoutSessionExpiresAt)) return;
  try {
    await core.gateway.expireCheckoutSession(sessionId);
  } catch (err) {
    core.log(`expire of ${sessionId} for ${order.id} failed (re-observing): ${errorText(err)}`);
  }
  let session: ObservedCheckoutSession;
  try {
    session = await core.gateway.retrieveCheckoutSession(sessionId);
  } catch (err) {
    core.log(`could not retrieve ${sessionId}: ${errorText(err)}`);
    return;
  }
  await applySession(core, order, session, 'reconcile');
}
