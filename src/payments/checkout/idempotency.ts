/**
 * Idempotency-key replay shared by the UCP and ACP doors (Stripe-style: replay the stored
 * response, 409 while the same key is in flight, conflict when the body differs).
 *
 * Only completed 2xx responses are durable (24h): an error is never replayed (the retry re-runs),
 * so failed or junk requests store nothing. The in-flight marker lives in this process only:
 * one process serves a DATA_DIR (lockfile), so work in flight cannot outlive a restart, and the
 * marker is cleared in `finally`, so a throw or crash never leaves a key stuck "in flight".
 */
import { createHash } from 'node:crypto';
import type { PaymentsStore } from '../store/index.js';

const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** Longest Idempotency-Key the doors accept; longer keys are rejected as malformed. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

interface StoredResponse {
  id: string;
  bodyHash: string;
  httpStatus: number;
  body: unknown;
  createdAt: string;
  expiresAt: string;
  version: number;
}

export interface IdempotentResponse {
  status: number;
  body: unknown;
  /**
   * False when the outcome is not final (payment pending) or changed nothing (a no-op cancel or
   * complete): never replayed, the retry re-runs — so fresh keys on no-op calls store nothing.
   * Non-2xx is never stored.
   */
  store?: boolean;
}

export type IdempotencyResult =
  | { kind: 'executed'; status: number; body: unknown }
  | { kind: 'replayed'; status: number; body: unknown }
  | { kind: 'in_flight' }
  | { kind: 'conflict' };

export interface IdempotencyKeys {
  /** Runs `fn` once per `id`; `bodyHash` must match for a replay. `fn` throwing is never cached. */
  run(id: string, bodyHash: string, fn: () => Promise<IdempotentResponse>): Promise<IdempotencyResult>;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Record id for a key within a scope (door + path/tool + identity); never stores the raw key. */
export function idempotencyId(...scope: string[]): string {
  return `idem_${sha256(scope.join('\n'))}`;
}

export function hashBody(body: unknown): string {
  return sha256(JSON.stringify(body ?? {}));
}

export function createIdempotencyKeys(store: PaymentsStore, collection: string, now: () => Date): IdempotencyKeys {
  const responses = store.collection<StoredResponse>(collection, {
    prunable: (record, ctx) => ctx.now.getTime() >= Date.parse(record.expiresAt),
  });
  const inFlight = new Set<string>();

  return {
    async run(id, bodyHash, fn) {
      // Check-and-mark is synchronous: no await between `has` and `add`.
      if (inFlight.has(id)) return { kind: 'in_flight' };
      const existing = responses.get(id);
      if (existing && Date.parse(existing.expiresAt) > now().getTime()) {
        if (existing.bodyHash !== bodyHash) return { kind: 'conflict' };
        return { kind: 'replayed', status: existing.httpStatus, body: existing.body };
      }
      inFlight.add(id);
      try {
        const outcome = await fn();
        if (outcome.store !== false && outcome.status >= 200 && outcome.status < 300) {
          const createdAt = now();
          await responses.put({
            id,
            bodyHash,
            httpStatus: outcome.status,
            body: outcome.body,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
            version: 0,
          });
        }
        return { kind: 'executed', status: outcome.status, body: outcome.body };
      } finally {
        inFlight.delete(id);
      }
    },
  };
}
