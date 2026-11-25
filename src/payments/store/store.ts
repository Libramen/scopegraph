/**
 * PaymentsStore — one durable JSON document (`DATA_DIR/payments.json`) holding
 * orders, the quotes they were started from, consumed approval nonces and
 * module-owned collections (checkouts, ACP idempotency records). One file ⇒ no
 * cross-file tearing.
 *
 * Fresh quotes (every qualified scope call) live in memory only — bounded and
 * TTL-pruned — and become durable in the same write as the first order started
 * from them (orders also carry a frozen copy). A restart forgets unstarted
 * quotes: the buyer re-scopes.
 *
 * Every mutation is a transaction: clone → apply → serialize → write tmp →
 * fsync → rename → fsync dir, serialized by a store-level mutex and awaited
 * by the caller — so a state written before a Stripe call is on disk before
 * the call starts. Readers only ever see committed (durable) state, and all
 * reads return copies (mutate through the store, never through a result).
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Order, StoredQuote } from '../types.js';
import { IS_TERMINAL } from '../types.js';
import { LockManager } from './locks.js';

export interface ConsumedNonce {
  orderId: string;
  consumedAt: string;
  /** The token's own expiry; the nonce is pruned after it. */
  expiresAt: string;
}

export interface StoreData {
  schema: 1;
  quotes: Record<string, StoredQuote>;
  orders: Record<string, Order>;
  nonces: Record<string, ConsumedNonce>;
  collections: Record<string, Record<string, unknown>>;
}

export type CasResult<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict' };

/** Records kept in a collection carry their own id and a CAS version. */
export interface CollectionRecord {
  id: string;
  version: number;
}

export interface CollectionOptions<T> {
  /** Run in every prune pass (reconciler sweep); return true to delete. Must be synchronous. */
  prunable?(record: T, ctx: { now: Date; order(id: string): Order | undefined }): boolean;
}

export interface Collection<T extends CollectionRecord> {
  get(id: string): T | undefined;
  list(): T[];
  /** Insert or overwrite (version kept as given). Durable. */
  put(record: T): Promise<T>;
  /** CAS on `version`; bumps it by one. Durable. */
  update(id: string, expectedVersion: number, mutate: (draft: T) => void): Promise<CasResult<T>>;
  delete(id: string): Promise<boolean>;
}

/** Where the serialized document lives. */
export interface StoreBackend {
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
  close(): Promise<void>;
}

const HOUR_MS = 3_600_000;
const QUOTE_RETENTION_MS = HOUR_MS; // after expiry
const UNPAID_RETENTION_MS = 48 * HOUR_MS; // never-paid terminal orders, after terminal
const UNHELD_LINK_RETENTION_MS = HOUR_MS; // link orders that closed without ever holding money
const PAID_RETENTION_MS = 90 * 24 * HOUR_MS; // paid / refunded orders
/** In-memory (unstarted) quotes kept at most; at the cap expired ones are dropped, live ones never evicted. */
export const MAX_MEMORY_QUOTES = 10_000;

function emptyData(): StoreData {
  return { schema: 1, quotes: {}, orders: {}, nonces: {}, collections: {} };
}

/**
 * `record[key]` for an own key only: ids come from requests, and `__proto__` /
 * `constructor` must read as "no such record", never as Object.prototype.
 */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** In-process backend for tests; keeps the last saved text so a "restart" can reopen it. */
export class MemoryBackend implements StoreBackend {
  text: string | undefined;
  saves = 0;

  async load(): Promise<string | undefined> {
    return this.text;
  }

  async save(text: string): Promise<void> {
    this.text = text;
    this.saves += 1;
  }

  async close(): Promise<void> {}
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

export interface FileLockOptions {
  /** How often the holder refreshes the lockfile's mtime (default 10s). */
  heartbeatMs?: number;
  /** A lock whose heartbeat is older than this is stale and may be taken over (default 60s). */
  staleMs?: number;
  /** Boot polls a fresh foreign lock this often while waiting for it to go stale (default 2s). */
  pollMs?: number;
  /** How long boot waits for a fresh lock with no visible heartbeat (default staleMs + heartbeatMs). */
  waitMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;

interface LockSnapshot {
  text: string;
  mtimeMs: number;
}

async function inspectLock(file: string): Promise<LockSnapshot | undefined> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { text, mtimeMs: stat.mtimeMs };
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/** Atomic exclusive create (`wx`): true when we created it. */
async function createExclusive(file: string, text: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable file backend. Holds an exclusive `DATA_DIR/.lock` for the life of
 * the process: `{ pid, hostname, startedAt, token }`, created atomically
 * (`wx`), its mtime refreshed every ~10s as a heartbeat. Liveness is judged by
 * the heartbeat only (never by pid: containers sharing a volume are all pid 1):
 * a lock is stale once its heartbeat is older than ~60s. Boot waits up to that
 * long for a silent lock to go stale (crash restart) and fails as soon as it
 * sees a heartbeat (another live server). If the holder ever finds its lock
 * replaced, every later write fails instead of racing the new holder.
 */
class FileBackend implements StoreBackend {
  private heartbeat: NodeJS.Timeout | undefined;
  private beating: Promise<void> = Promise.resolve();
  private lost = false;
  private closed = false;

  private constructor(
    private readonly dir: string,
    private readonly lockPath: string,
    private readonly lockText: string,
  ) {}

  get file(): string {
    return path.join(this.dir, 'payments.json');
  }

  static async open(dataDir: string, options: FileLockOptions = {}): Promise<FileBackend> {
    const dir = path.resolve(dataDir);
    // Owner-only when we create it (an existing directory keeps its mode).
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(dir, '.lock');
    const lockText = `${JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: randomBytes(12).toString('hex'),
    })}\n`;
    await FileBackend.acquireLock(lockPath, lockText, options);
    const backend = new FileBackend(dir, lockPath, lockText);
    backend.startHeartbeat(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    return backend;
  }

  private static lockedError(lockPath: string, blocker: 'heartbeat' | 'takeover', staleMs: number): Error {
    const dir = path.dirname(lockPath);
    const stale = `${String(Math.round(staleMs / 1000))}s`;
    if (blocker === 'takeover') {
      return new Error(
        `payments data directory ${dir}: a takeover of its stale lock is in progress (${lockPath}.takeover). `
          + `If no other scopegraph server is starting on this DATA_DIR, the takeover file is cleared automatically `
          + `once it is ${stale} old — retry then.`,
      );
    }
    return new Error(
      `payments data directory ${dir} is locked by another running scopegraph server (the heartbeat of ${lockPath} `
        + `is under ${stale} old). Run one server per DATA_DIR; a lock left by a stopped server is taken over `
        + `automatically once its heartbeat is ${stale} old.`,
    );
  }

  private static async acquireLock(lockPath: string, lockText: string, options: FileLockOptions): Promise<void> {
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const waitMs = options.waitMs ?? staleMs + (options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    let deadline = Date.now() + waitMs;
    // Outwaiting a takeover file never extends boot past one more stale period.
    const hardDeadline = deadline + staleMs + 2 * pollMs;
    let first: LockSnapshot | undefined;
    for (;;) {
      if (await createExclusive(lockPath, lockText)) return;
      const seen = await inspectLock(lockPath);
      if (seen === undefined) continue; // released meanwhile: try the exclusive create again
      if (Date.now() - seen.mtimeMs > staleMs) {
        const busySince = await FileBackend.removeStale(lockPath, seen, staleMs);
        if (busySince !== undefined) {
          // Another taker holds the takeover file: outwait it in case it crashed holding it.
          deadline = Math.min(Math.max(deadline, busySince + staleMs + 2 * pollMs), hardDeadline);
          if (Date.now() >= deadline) throw FileBackend.lockedError(lockPath, 'takeover', staleMs);
          await sleep(pollMs);
        }
        continue; // `wx` arbitrates between processes taking over at once
      }
      // A changing lock (heartbeat or new holder) proves a live process.
      if (first !== undefined && (seen.mtimeMs !== first.mtimeMs || seen.text !== first.text)) {
        throw FileBackend.lockedError(lockPath, 'heartbeat', staleMs);
      }
      first ??= seen;
      if (Date.now() >= deadline) throw FileBackend.lockedError(lockPath, 'heartbeat', staleMs);
      await sleep(pollMs);
    }
  }

  /**
   * Remove a stale lock without ever deleting a fresh one. Takers serialize on
   * an exclusive `.lock.takeover` file (held for milliseconds) and re-check,
   * while holding it, that the lock is still the exact stale one they judged.
   * A takeover file older than the stale limit was left by a crashed taker: it
   * is removed and the exclusive create retried. Returns the mtime of a live
   * takeover file that blocked us, or undefined when the takeover was done.
   */
  private static async removeStale(lockPath: string, stale: LockSnapshot, staleMs: number): Promise<number | undefined> {
    const takeover = `${lockPath}.takeover`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await createExclusive(takeover, `${String(process.pid)}\n`)) {
        try {
          const current = await inspectLock(lockPath);
          if (current !== undefined && current.text === stale.text && current.mtimeMs === stale.mtimeMs) {
            await fs.rm(lockPath, { force: true });
          }
        } finally {
          await fs.rm(takeover, { force: true });
        }
        return undefined;
      }
      const other = await inspectLock(takeover);
      if (other === undefined) continue; // released meanwhile: retry the exclusive create
      if (Date.now() - other.mtimeMs <= staleMs) return other.mtimeMs;
      await fs.rm(takeover, { force: true });
    }
    return Date.now();
  }

  private startHeartbeat(everyMs: number): void {
    this.heartbeat = setInterval(() => {
      this.beating = this.beat().catch((err: unknown) => {
        console.error(`scopegraph payments: DATA_DIR lock heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, everyMs);
    this.heartbeat.unref();
  }

  /** Refresh our lock's mtime; detect a lock that is no longer ours. */
  private async beat(): Promise<void> {
    if (this.lost || this.closed) return;
    const current = await inspectLock(this.lockPath);
    if (current === undefined) {
      // Deleted by hand (or moved aside for a moment): re-take it unless someone else has.
      if (await createExclusive(this.lockPath, this.lockText)) return;
      return this.beat();
    }
    if (current.text !== this.lockText) {
      this.lost = true;
      clearInterval(this.heartbeat);
      console.error(
        `scopegraph payments: LOST the DATA_DIR lock ${this.lockPath} to another process — refusing every further `
          + 'payments write. Stop one of the servers sharing this DATA_DIR and restart this one.',
      );
      return;
    }
    const now = new Date();
    await fs.utimes(this.lockPath, now, now);
  }

  async load(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined;
      throw err;
    }
  }

  async save(text: string): Promise<void> {
    if (this.lost) throw new Error(`payments DATA_DIR lock ${this.lockPath} was taken by another process; not writing`);
    // Exclusive create under an unpredictable name: never writes through a planted symlink or file.
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    const dirHandle = await fs.open(this.dir, 'r');
    try {
      await dirHandle.sync();
    } catch (err) {
      // Some filesystems refuse fsync on a directory; the rename is still atomic.
      const code = errnoCode(err);
      if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR' && code !== 'ENOTSUP') throw err;
    } finally {
      await dirHandle.close();
    }
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.closed = true;
    await this.beating;
    const holder = await fs.readFile(this.lockPath, 'utf8').catch(() => '');
    if (holder === this.lockText) await fs.rm(this.lockPath, { force: true });
  }
}

export class PaymentsStore {
  readonly locks = new LockManager();
  private queue: Promise<unknown> = Promise.resolve();
  /** Unstarted quotes (insertion order = age); never written to disk. */
  private readonly memoryQuotes = new Map<string, StoredQuote>();
  private readonly clientMemoryQuotes = new Map<string, Set<string>>();
  private readonly pruners = new Map<string, NonNullable<CollectionOptions<CollectionRecord>['prunable']>>();

  private constructor(
    private readonly backend: StoreBackend,
    private data: StoreData,
  ) {}

  /** Durable store in `dataDir` (takes the DATA_DIR lockfile). */
  static async open(dataDir: string, lock?: FileLockOptions): Promise<PaymentsStore> {
    return PaymentsStore.fromBackend(await FileBackend.open(dataDir, lock));
  }

  /** In-memory store (tests). Pass a `MemoryBackend` you kept to simulate a restart. */
  static async memory(backend: MemoryBackend = new MemoryBackend()): Promise<PaymentsStore> {
    return PaymentsStore.fromBackend(backend);
  }

  static async fromBackend(backend: StoreBackend): Promise<PaymentsStore> {
    let text: string | undefined;
    try {
      text = await backend.load();
    } catch (err) {
      await backend.close();
      throw err;
    }
    if (text === undefined) return new PaymentsStore(backend, emptyData());
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await backend.close();
      throw new Error('payments.json is not valid JSON — restore it from a backup before starting payments.');
    }
    if (typeof parsed !== 'object' || parsed === null || !('schema' in parsed) || parsed.schema !== 1) {
      await backend.close();
      throw new Error('payments.json has an unknown schema version.');
    }
    return new PaymentsStore(backend, { ...emptyData(), ...(parsed as StoreData) });
  }

  /**
   * The one write path: `fn` mutates a draft; returning `write: false` skips
   * persistence (nothing changed). Serialized; resolves once durable.
   */
  private transact<R>(fn: (draft: StoreData) => { value: R; write: boolean }): Promise<R> {
    const run = async (): Promise<R> => {
      const draft = structuredClone(this.data);
      const { value, write } = fn(draft);
      if (write) {
        await this.backend.save(JSON.stringify(draft));
        this.data = draft;
      }
      return value;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Resolves when every queued write is durable. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.backend.close();
  }

  // ── Quotes ─────────────────────────────────────────────────────────────────

  /** A started quote (durable) or a fresh one (memory). */
  getQuote(id: string): StoredQuote | undefined {
    const quote = own(this.data.quotes, id) ?? this.memoryQuotes.get(id);
    return quote === undefined ? undefined : structuredClone(quote);
  }

  /**
   * Keep a fresh quote in memory (no disk write), bounded by `MAX_MEMORY_QUOTES`.
   * At the cap expired quotes are dropped; a live quote is never evicted, so a
   * still-full store refuses the new one (undefined). Indexed by `quote.client`.
   */
  rememberQuote(quote: StoredQuote, now: Date): StoredQuote | undefined {
    if (this.memoryQuotes.size >= MAX_MEMORY_QUOTES) this.dropMemoryQuotes(now.getTime(), 0);
    if (this.memoryQuotes.size >= MAX_MEMORY_QUOTES) return undefined;
    this.memoryQuotes.set(quote.id, structuredClone(quote));
    if (quote.client !== undefined) {
      let held = this.clientMemoryQuotes.get(quote.client);
      if (held === undefined) {
        held = new Set();
        this.clientMemoryQuotes.set(quote.client, held);
      }
      held.add(quote.id);
    }
    return structuredClone(quote);
  }

  /** Unexpired quotes that clients `holds` accepts asked for and that no order has started yet. */
  unstartedQuotesHeldBy(holds: (client: string) => boolean, now: Date): number {
    let live = 0;
    for (const [client, ids] of this.clientMemoryQuotes) {
      if (!holds(client)) continue;
      for (const id of ids) {
        const quote = this.memoryQuotes.get(id);
        if (quote !== undefined && Date.parse(quote.expiresAt) > now.getTime()) live += 1;
      }
    }
    return live;
  }

  /** A copy of the first unstarted quote of `client` that `match` accepts. */
  findUnstartedQuote(client: string, match: (quote: Readonly<StoredQuote>) => boolean): StoredQuote | undefined {
    for (const id of this.clientMemoryQuotes.get(client) ?? []) {
      const quote = this.memoryQuotes.get(id);
      if (quote !== undefined && match(quote)) return structuredClone(quote);
    }
    return undefined;
  }

  private forgetMemoryQuote(id: string): void {
    const client = this.memoryQuotes.get(id)?.client;
    this.memoryQuotes.delete(id);
    if (client === undefined) return;
    const held = this.clientMemoryQuotes.get(client);
    held?.delete(id);
    if (held?.size === 0) this.clientMemoryQuotes.delete(client);
  }

  /** Mark a quote expired at `at` (no-op if already earlier): durable for a started quote. */
  async expireQuote(id: string, at: string): Promise<void> {
    const fresh = this.memoryQuotes.get(id);
    if (fresh !== undefined && Date.parse(fresh.expiresAt) > Date.parse(at)) fresh.expiresAt = at;
    if (own(this.data.quotes, id) === undefined) return;
    await this.transact((draft) => {
      const quote = own(draft.quotes, id);
      if (quote === undefined || Date.parse(quote.expiresAt) <= Date.parse(at)) return { value: undefined, write: false };
      quote.expiresAt = at;
      return { value: undefined, write: true };
    });
  }

  private dropMemoryQuotes(t: number, retentionMs: number): number {
    let removed = 0;
    for (const [id, quote] of this.memoryQuotes) {
      if (Date.parse(quote.expiresAt) + retentionMs < t) {
        this.forgetMemoryQuote(id);
        removed += 1;
      }
    }
    return removed;
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  getOrder(id: string): Order | undefined {
    const order = own(this.data.orders, id);
    return order === undefined ? undefined : structuredClone(order);
  }

  listOrders(): Order[] {
    return Object.values(this.data.orders).map((o) => structuredClone(o));
  }

  ordersForQuote(quoteId: string): Order[] {
    return Object.values(this.data.orders)
      .filter((o) => o.quoteId === quoteId)
      .map((o) => structuredClone(o));
  }

  /** How many orders `match` accepts (no copies: `match` must not keep or mutate the order). */
  countOrders(match: (order: Readonly<Order>) => boolean): number {
    let count = 0;
    for (const order of Object.values(this.data.orders)) if (match(order)) count += 1;
    return count;
  }

  /** Durable insert; the order's quote becomes durable in the same write (if it was only in memory). */
  async insertOrder(order: Order): Promise<Order> {
    const inserted = await this.transact((draft) => {
      if (own(draft.orders, order.id) !== undefined) throw new Error(`order ${order.id} already exists`);
      draft.orders[order.id] = structuredClone(order);
      const fresh = this.memoryQuotes.get(order.quoteId);
      if (own(draft.quotes, order.quoteId) === undefined && fresh !== undefined) draft.quotes[order.quoteId] = structuredClone(fresh);
      return { value: structuredClone(order), write: true };
    });
    if (own(this.data.quotes, order.quoteId) !== undefined) this.forgetMemoryQuote(order.quoteId);
    return inserted;
  }

  /** CAS on `version`; bumps it. `mutate` may also touch the order's quote (e.g. mark it expired). */
  updateOrder(
    id: string,
    expectedVersion: number,
    mutate: (draft: Order, data: { quotes: Record<string, StoredQuote> }) => void,
  ): Promise<CasResult<Order>> {
    return this.transact<CasResult<Order>>((draft) => {
      const order = own(draft.orders, id);
      if (order === undefined) return { value: { ok: false, reason: 'not_found' } as const, write: false };
      if (order.version !== expectedVersion) return { value: { ok: false, reason: 'conflict' } as const, write: false };
      mutate(order, { quotes: draft.quotes });
      order.version = expectedVersion + 1;
      return { value: { ok: true, value: structuredClone(order) } as const, write: true };
    });
  }

  // ── Approval nonces ────────────────────────────────────────────────────────

  /** Single-use claim: true exactly once per nonce (durable before returning). */
  claimNonce(nonce: string, entry: ConsumedNonce): Promise<boolean> {
    return this.transact((draft) => {
      if (own(draft.nonces, nonce) !== undefined) return { value: false, write: false };
      draft.nonces[nonce] = { ...entry };
      return { value: true, write: true };
    });
  }

  isNonceConsumed(nonce: string): boolean {
    return own(this.data.nonces, nonce) !== undefined;
  }

  // ── Module-owned collections (checkouts, ACP idempotency, …) ───────────────

  collection<T extends CollectionRecord>(name: string, options: CollectionOptions<T> = {}): Collection<T> {
    if (options.prunable !== undefined) {
      const prunable = options.prunable;
      this.pruners.set(name, (record, ctx) => prunable(record as T, ctx));
    }
    const records = (data: StoreData): Record<string, T> => {
      data.collections[name] ??= {};
      return data.collections[name] as Record<string, T>;
    };
    return {
      get: (id) => {
        const record = own(this.data.collections[name], id);
        return record === undefined ? undefined : (structuredClone(record) as T);
      },
      list: () => Object.values(this.data.collections[name] ?? {}).map((r) => structuredClone(r) as T),
      put: (record) =>
        this.transact((draft) => {
          records(draft)[record.id] = structuredClone(record);
          return { value: structuredClone(record), write: true };
        }),
      update: (id, expectedVersion, mutate) =>
        this.transact<CasResult<T>>((draft) => {
          const record = own(records(draft), id);
          if (record === undefined) return { value: { ok: false, reason: 'not_found' } as const, write: false };
          if (record.version !== expectedVersion) return { value: { ok: false, reason: 'conflict' } as const, write: false };
          mutate(record);
          record.version = expectedVersion + 1;
          return { value: { ok: true, value: structuredClone(record) } as const, write: true };
        }),
      delete: (id) =>
        this.transact((draft) => {
          const map = records(draft);
          if (own(map, id) === undefined) return { value: false, write: false };
          delete map[id];
          return { value: true, write: true };
        }),
    };
  }

  // ── Pruning ────────────────────────────────────────────────────────────────

  /**
   * Quotes (memory and durable) 1h after expiry; link orders that closed
   * without ever holding money (expired/canceled Checkout Session) 1h after
   * closing; other never-paid terminal orders 48h after their last transition;
   * paid/refunded orders after 90 days; orders
   * with pending hooks, a `discrepancy` flag or an unresolved release are kept;
   * consumed nonces after their token expires; collections by their own
   * predicate. Returns how many records were removed.
   */
  prune(now: Date): Promise<number> {
    const t = now.getTime();
    const forgotten = this.dropMemoryQuotes(t, QUOTE_RETENTION_MS);
    return this.transact((draft) => {
      let removed = forgotten;
      for (const [id, quote] of Object.entries(draft.quotes)) {
        if (Date.parse(quote.expiresAt) + QUOTE_RETENTION_MS < t) {
          delete draft.quotes[id];
          removed += 1;
        }
      }
      for (const [id, order] of Object.entries(draft.orders)) {
        if (!IS_TERMINAL[order.status] || order.pendingHooks.length > 0) continue;
        if (order.statusReason === 'discrepancy' || (order.releases?.length ?? 0) > 0) continue;
        const since = Date.parse(order.lastOperation?.at ?? order.createdAt);
        const unheldLink = order.door === 'link' && (order.status === 'expired' || order.status === 'canceled')
          && order.stripe.paymentIntentId === undefined && order.voidOutcome === undefined;
        const keep = order.status === 'paid' || order.status === 'refunded'
          ? PAID_RETENTION_MS
          : unheldLink ? UNHELD_LINK_RETENTION_MS : UNPAID_RETENTION_MS;
        if (since + keep < t) {
          delete draft.orders[id];
          removed += 1;
        }
      }
      for (const [nonce, entry] of Object.entries(draft.nonces)) {
        if (Date.parse(entry.expiresAt) < t) {
          delete draft.nonces[nonce];
          removed += 1;
        }
      }
      const order = (id: string): Order | undefined => own(draft.orders, id);
      for (const [name, prunable] of this.pruners) {
        const map = draft.collections[name];
        if (map === undefined) continue;
        for (const [id, record] of Object.entries(map)) {
          if (prunable(record as CollectionRecord, { now, order })) {
            delete map[id];
            removed += 1;
          }
        }
      }
      return { value: removed, write: removed > forgotten };
    });
  }
}
