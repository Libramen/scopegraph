/**
 * Per-key FIFO async mutex.
 *
 * Keys used by payments: `checkout:<id>`, `quote:<id>`, `order:<id>`,
 * `checkout-admission` (checkout cap check + write) and `order-admission`
 * (per-door unpaid-order cap check + insert); the two admission locks are
 * innermost, nothing is taken while holding one. Acquisition order is always checkout → quote →
 * order; never take an earlier kind while holding a later one. In-process
 * only (the DATA_DIR lockfile guarantees a single process).
 */
export class LockManager {
  private readonly queues = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    }
  }
}
