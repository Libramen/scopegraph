/**
 * Hook runner — delivers the `pendingHooks` that `commit` recorded with each
 * transition to `src/extend/orders.ts` (or injected hooks).
 *
 * Invariants that live here:
 * - Hooks run after the order lock is released, never inside it; only the
 *   bookkeeping write afterwards takes the order lock.
 * - At-least-once: an entry leaves `pendingHooks` only after a successful call
 *   or `MAX_HOOK_ATTEMPTS` failures. A call still running after the timeout
 *   counts as a failure (it may finish in the background).
 * - Nobody waits on hooks except `drain` (tests, shutdown): `kick` starts or
 *   joins one run per order, so a hung hook never holds up the sweep.
 */
import type { HookName, Order } from '../types.js';
import { approvalLinks } from '../approval/tokens.js';
import type { ApprovalLinks } from '../approval/tokens.js';
import type { OrderCore } from './core.js';

export interface OrderHooks {
  onApprovalNeeded(order: Order, links: ApprovalLinks): Promise<void>;
  onPaid(order: Order): Promise<void>;
  onClosed(order: Order): Promise<void>;
}

const MAX_HOOK_ATTEMPTS = 5;
export const HOOK_TIMEOUT_MS = 10_000;

export class HookRunner {
  private readonly runs = new Map<string, Promise<void>>();

  constructor(
    private readonly core: OrderCore,
    private readonly hooks: OrderHooks,
    private readonly timeoutMs: number,
  ) {}

  /** Start (or join) a hook run for an order without awaiting it. */
  kick(orderId: string): void {
    if ((this.core.store.getOrder(orderId)?.pendingHooks.length ?? 0) === 0) return;
    void this.run(orderId);
  }

  /** Resolves when every in-flight hook run has finished (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.runs.size > 0) await Promise.all([...this.runs.values()]);
  }

  /** One pass over an order's pending hooks; each entry is tried once. */
  run(orderId: string): Promise<void> {
    const running = this.runs.get(orderId);
    if (running !== undefined) return running;
    const run = this.runOnce(orderId).finally(() => {
      this.runs.delete(orderId);
    });
    this.runs.set(orderId, run);
    return run;
  }

  private async runOnce(orderId: string): Promise<void> {
    const { store, log } = this.core;
    const pending = store.getOrder(orderId)?.pendingHooks ?? [];
    for (const entry of pending) {
      const order = store.getOrder(orderId);
      if (order === undefined) return;
      let ok = true;
      try {
        await this.invokeWithTimeout(entry.hook, order);
      } catch (err) {
        ok = false;
        log(`hook ${entry.hook} for ${orderId} failed (attempt ${String(entry.attempts + 1)}): ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.core.withOrderLock(orderId, async () => {
        const current = store.getOrder(orderId);
        if (current === undefined) return;
        const result = await store.updateOrder(orderId, current.version, (draft) => {
          const index = draft.pendingHooks.findIndex((h) => h.hook === entry.hook);
          if (index < 0) return;
          const hook = draft.pendingHooks[index];
          if (hook === undefined) return;
          if (ok) {
            draft.pendingHooks.splice(index, 1);
            return;
          }
          hook.attempts += 1;
          if (hook.attempts >= MAX_HOOK_ATTEMPTS) {
            draft.pendingHooks.splice(index, 1);
            log(`hook ${entry.hook} for ${orderId} given up after ${String(MAX_HOOK_ATTEMPTS)} attempts`);
          }
        });
        if (!result.ok) log(`hook bookkeeping for ${orderId} skipped (${result.reason})`);
      });
    }
  }

  /** A hook still running after `timeoutMs` counts as failed (it may still finish in the background). */
  private async invokeWithTimeout(hook: HookName, order: Order): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${String(this.timeoutMs)}ms`));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([this.invoke(hook, order), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async invoke(hook: HookName, order: Order): Promise<void> {
    switch (hook) {
      case 'onApprovalNeeded': {
        // Stale entry (already decided): nothing to ask the owner any more.
        if (order.status !== 'awaiting_approval' || order.approvalDeadline === undefined) return;
        const links = approvalLinks({
          orderId: order.id,
          deadline: new Date(order.approvalDeadline),
          publicUrl: this.core.config.publicUrl,
          secret: this.core.config.signingSecret,
        });
        await this.hooks.onApprovalNeeded(order, links);
        return;
      }
      case 'onPaid':
        await this.hooks.onPaid(order);
        return;
      case 'onClosed':
        await this.hooks.onClosed(order);
        return;
    }
  }
}
