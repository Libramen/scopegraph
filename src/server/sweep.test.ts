/**
 * Wiring-level check: a hung ACP outbox delivery or a hung hook never
 * holds the reconciler's coalesced sweep hostage.
 */
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type * as AcpModule from '../payments/acp/index.js';
import { setupPayments } from '../payments/index.js';
import { PaymentsStore } from '../payments/store/index.js';
import { FakeGateway } from '../payments/stripe/index.js';
import { lessonGraph, testConfig } from '../payments/orders/test-harness.js';

const delivery = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../payments/acp/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AcpModule>();
  return {
    ...actual,
    // An ACP platform that accepts the connection and never answers.
    deliverPendingAcpWebhooks: () => {
      delivery.calls += 1;
      return new Promise<void>(() => undefined);
    },
  };
});

describe('sweep coalescing', () => {
  it('a hung ACP delivery or hook does not stop the next reconcile from running', async () => {
    const graph = lessonGraph();
    const hung = new Promise<void>(() => undefined);
    const payments = await setupPayments({
      getGraph: () => graph,
      config: testConfig({ acp: { bearerTokens: ['tok'], webhookUrl: 'https://agent.example.com/hook', webhookSecret: 'secret' } }),
      gateway: new FakeGateway(),
      store: await PaymentsStore.memory(),
      hooks: { onApprovalNeeded: () => hung, onPaid: () => hung, onClosed: () => hung },
      log: () => undefined,
    });
    const reconcile = vi.spyOn(payments.service, 'reconcile');

    // An order with a hung onApprovalNeeded hook.
    const scoped = await payments.scope.createQuote('lesson', { answers: { participants: 2 }, selections: {} }, {
      currency: 'USD', lines: [], subtotalCents: 14600, taxCents: 0, totalCents: 14600,
    });
    if (scoped === undefined) throw new Error('quote not payable');
    const paid = await payments.service.payWithSpt({ quoteId: scoped.id, door: 'ucp', spt: 'spt_sweep', buyer: { email: 'a@example.com' } });
    expect(paid).toMatchObject({ ok: true, value: { status: 'awaiting_approval' } });

    void payments.sweep();
    void payments.sweep();
    await vi.waitFor(() => {
      expect(delivery.calls).toBe(1);
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    // Delivery is still hanging (and the hook too): a later sweep reconciles again,
    // and joins the in-flight delivery instead of stacking another.
    void payments.sweep();
    await vi.waitFor(() => {
      expect(reconcile).toHaveBeenCalledTimes(2);
    });
    await reconcile.mock.results[1]?.value;
    await tick();
    expect(delivery.calls).toBe(1);
    await payments.store.close();
  });
});
