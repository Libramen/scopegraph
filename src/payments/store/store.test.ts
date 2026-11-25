import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Order, StoredQuote } from '../types.js';
import { LockManager, MAX_MEMORY_QUOTES, MemoryBackend, PaymentsStore, isId, newId } from './index.js';
import type { StoreBackend } from './index.js';

const T0 = new Date('2026-07-01T00:00:00.000Z');
const HOUR = 3_600_000;

function quote(id: string, expiresAt: Date): StoredQuote {
  return {
    id,
    offering: 'lesson',
    request: { answers: { participants: 2 }, selections: {} },
    quote: { currency: 'USD', lines: [], subtotalCents: 14600, taxCents: 0, totalCents: 14600 },
    createdAt: T0.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    quoteId: 'qt_x',
    offering: 'lesson',
    request: { answers: {}, selections: {} },
    quote: { currency: 'USD', lines: [], subtotalCents: 14600, taxCents: 0, totalCents: 14600 },
    confirmation: 'owner_approves',
    door: 'ucp',
    createdAt: T0.toISOString(),
    stripe: {},
    status: 'authorizing',
    pendingHooks: [],
    version: 0,
    ...overrides,
  };
}

describe('ids', () => {
  it('are prefix + 24 base32 chars (120 bits) and unique', () => {
    const ids = new Set<string>();
    for (const prefix of ['qt', 'ord', 'chk'] as const) {
      for (let i = 0; i < 500; i++) {
        const id = newId(prefix);
        expect(id).toMatch(new RegExp(`^${prefix}_[a-z2-7]{24}$`));
        expect(isId(prefix, id)).toBe(true);
        ids.add(id);
      }
    }
    expect(ids.size).toBe(1500);
    expect(isId('ord', 'qt_aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isId('ord', 'ord_AAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(isId('ord', 'ord_aaaa')).toBe(false);
    expect(isId('ord', 42)).toBe(false);
  });

  it('use every base32 symbol (no truncated entropy)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) for (const ch of newId('qt').slice(3)) seen.add(ch);
    expect(seen.size).toBe(32);
  });
});

describe('LockManager', () => {
  it('runs same-key work FIFO, one at a time, and survives failures', async () => {
    const locks = new LockManager();
    const log: string[] = [];
    const step = (name: string, fail = false) => locks.withLock('k', async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    });
    const results = await Promise.allSettled([step('a'), step('b', true), step('c')]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('does not serialize different keys', async () => {
    const locks = new LockManager();
    const log: string[] = [];
    await Promise.all([
      locks.withLock('a', async () => {
        log.push('a1');
        await tick();
        await tick();
        log.push('a2');
      }),
      locks.withLock('b', async () => {
        log.push('b1');
      }),
    ]);
    expect(log).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('PaymentsStore (memory backend)', () => {
  it('CAS-updates orders, bumping the version; conflicts and unknown ids write nothing', async () => {
    const backend = new MemoryBackend();
    const store = await PaymentsStore.memory(backend);
    await store.insertOrder(order('ord_1'));
    const saves = backend.saves;
    const updated = await store.updateOrder('ord_1', 0, (d) => {
      d.status = 'awaiting_approval';
    });
    expect(updated).toMatchObject({ ok: true, value: { status: 'awaiting_approval', version: 1 } });
    expect(await store.updateOrder('ord_1', 0, () => undefined)).toEqual({ ok: false, reason: 'conflict' });
    expect(await store.updateOrder('ord_x', 0, () => undefined)).toEqual({ ok: false, reason: 'not_found' });
    expect(backend.saves).toBe(saves + 1);
    await expect(store.insertOrder(order('ord_1'))).rejects.toThrow('already exists');
  });

  it('returns copies: mutating a result never changes the store', async () => {
    const store = await PaymentsStore.memory();
    await store.insertOrder(order('ord_1'));
    const copy = store.getOrder('ord_1');
    if (copy === undefined) throw new Error('missing');
    copy.status = 'paid';
    expect(store.getOrder('ord_1')?.status).toBe('authorizing');
  });

  it('readers only see durable state: a failed save leaves the previous state', async () => {
    let fail = false;
    const inner = new MemoryBackend();
    const backend: StoreBackend = {
      load: () => inner.load(),
      save: async (text) => {
        if (fail) throw new Error('disk full');
        await inner.save(text);
      },
      close: () => inner.close(),
    };
    const store = await PaymentsStore.fromBackend(backend);
    await store.insertOrder(order('ord_1'));
    fail = true;
    await expect(store.updateOrder('ord_1', 0, (d) => {
      d.status = 'paid';
    })).rejects.toThrow('disk full');
    expect(store.getOrder('ord_1')).toMatchObject({ status: 'authorizing', version: 0 });
    fail = false;
    expect(await store.updateOrder('ord_1', 0, (d) => {
      d.status = 'paid';
    })).toMatchObject({ ok: true });
  });

  it('serializes concurrent writes (no lost updates)', async () => {
    const store = await PaymentsStore.memory();
    const items = store.collection<{ id: string; version: number; n: number }>('counters');
    await items.put({ id: 'c', version: 0, n: 0 });
    await Promise.all(Array.from({ length: 20 }, () => (async () => {
      for (;;) {
        const current = items.get('c');
        if (current === undefined) throw new Error('missing');
        const result = await items.update('c', current.version, (d) => {
          d.n += 1;
        });
        if (result.ok) return;
      }
    })()));
    expect(items.get('c')).toMatchObject({ n: 20, version: 20 });
  });

  it('claims approval nonces exactly once', async () => {
    const store = await PaymentsStore.memory();
    const entry = { orderId: 'ord_1', consumedAt: T0.toISOString(), expiresAt: new Date(T0.getTime() + HOUR).toISOString() };
    const claims = await Promise.all([store.claimNonce('n1', entry), store.claimNonce('n1', entry), store.claimNonce('n1', entry)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(store.isNonceConsumed('n1')).toBe(true);
    expect(store.isNonceConsumed('n2')).toBe(false);
  });

  it('collections: get/list/put/update/delete', async () => {
    const store = await PaymentsStore.memory();
    const checkouts = store.collection<{ id: string; version: number; state: string }>('checkouts');
    expect(checkouts.get('chk_1')).toBeUndefined();
    await checkouts.put({ id: 'chk_1', version: 0, state: 'open' });
    await checkouts.put({ id: 'chk_2', version: 0, state: 'open' });
    expect(checkouts.list().map((c) => c.id).sort()).toEqual(['chk_1', 'chk_2']);
    expect(await checkouts.update('chk_1', 0, (d) => {
      d.state = 'done';
    })).toEqual({ ok: true, value: { id: 'chk_1', version: 1, state: 'done' } });
    expect(await checkouts.update('chk_1', 0, () => undefined)).toEqual({ ok: false, reason: 'conflict' });
    expect(await checkouts.delete('chk_2')).toBe(true);
    expect(await checkouts.delete('chk_2')).toBe(false);
    expect(checkouts.list()).toHaveLength(1);
  });

  it('prunes quotes 1h after expiry, unpaid terminal orders after 48h, paid after 90d, keeps live/hooked orders', async () => {
    const store = await PaymentsStore.memory();
    store.rememberQuote(quote('qt_old', T0), T0);
    store.rememberQuote(quote('qt_new', new Date(T0.getTime() + HOUR)), T0);
    const at = (h: number) => new Date(T0.getTime() + h * HOUR).toISOString();
    await store.insertOrder(order('ord_failed', { status: 'payment_failed', lastOperation: { op: 'x', result: 'payment_failed', at: at(0) } }));
    await store.insertOrder(order('ord_paid', { status: 'paid', lastOperation: { op: 'x', result: 'paid', at: at(0) } }));
    await store.insertOrder(order('ord_live', { status: 'awaiting_approval', lastOperation: { op: 'x', result: 'awaiting_approval', at: at(0) } }));
    await store.insertOrder(order('ord_hooked', { status: 'rejected', pendingHooks: [{ hook: 'onClosed', attempts: 1 }], lastOperation: { op: 'x', result: 'rejected', at: at(0) } }));
    // Money may still need giving back — never pruned.
    await store.insertOrder(order('ord_flagged', { status: 'canceled', statusReason: 'discrepancy', lastOperation: { op: 'x', result: 'canceled', at: at(0) } }));
    await store.insertOrder(order('ord_releasing', {
      status: 'payment_failed',
      releases: [{ paymentIntentId: 'pi_1', attempts: 10, nextAttemptAt: at(1) }],
      lastOperation: { op: 'x', result: 'payment_failed', at: at(0) },
    }));
    await store.claimNonce('n_old', { orderId: 'ord_live', consumedAt: at(0), expiresAt: at(1) });
    const checkouts = store.collection<{ id: string; version: number; orderId: string }>('checkouts', {
      prunable: (record, ctx) => ctx.order(record.orderId) === undefined,
    });
    await checkouts.put({ id: 'chk_live', version: 0, orderId: 'ord_live' });
    await checkouts.put({ id: 'chk_failed', version: 0, orderId: 'ord_failed' });

    await store.prune(new Date(T0.getTime() + 2 * HOUR));
    expect(store.getQuote('qt_old')).toBeUndefined();
    expect(store.getQuote('qt_new')).toBeDefined();
    expect(store.isNonceConsumed('n_old')).toBe(false);
    expect(store.getOrder('ord_failed')).toBeDefined();

    await store.prune(new Date(T0.getTime() + 49 * HOUR));
    expect(store.getOrder('ord_failed')).toBeUndefined();
    expect(store.getOrder('ord_hooked')).toBeDefined();
    expect(store.getOrder('ord_flagged')).toBeDefined();
    expect(store.getOrder('ord_releasing')).toBeDefined();
    expect(store.getOrder('ord_live')).toBeDefined();
    expect(store.getOrder('ord_paid')).toBeDefined();
    expect(checkouts.get('chk_failed')).toBeUndefined();
    expect(checkouts.get('chk_live')).toBeDefined();

    await store.prune(new Date(T0.getTime() + 91 * 24 * HOUR));
    expect(store.getOrder('ord_paid')).toBeUndefined();
    expect(store.getOrder('ord_live')).toBeDefined();
    expect(store.getOrder('ord_flagged')).toBeDefined();
    expect(store.getOrder('ord_releasing')).toBeDefined();
  });

  it('link orders that closed without ever holding money are pruned after 1h, not 48h', async () => {
    const store = await PaymentsStore.memory();
    const closed = { op: 'x', result: 'expired', at: T0.toISOString() };
    await store.insertOrder(order('ord_linkexpired', { door: 'link', status: 'expired', statusReason: 'checkout_expired', lastOperation: closed }));
    await store.insertOrder(order('ord_linkcanceled', { door: 'link', status: 'canceled', lastOperation: closed }));
    // Money was involved: keep the normal 48h.
    await store.insertOrder(order('ord_linkpi', { door: 'link', status: 'expired', stripe: { paymentIntentId: 'pi_1' }, lastOperation: closed }));
    await store.insertOrder(order('ord_linkvoided', { door: 'link', status: 'canceled', voidOutcome: 'canceled', lastOperation: closed }));
    await store.insertOrder(order('ord_ucpfailed', { door: 'ucp', status: 'payment_failed', lastOperation: closed }));
    await store.insertOrder(order('ord_linkhooked', { door: 'link', status: 'expired', pendingHooks: [{ hook: 'onClosed', attempts: 0 }], lastOperation: closed }));
    await store.insertOrder(order('ord_linkflagged', { door: 'link', status: 'canceled', statusReason: 'discrepancy', lastOperation: closed }));

    await store.prune(new Date(T0.getTime() + 61 * 60_000));
    expect(store.getOrder('ord_linkexpired')).toBeUndefined();
    expect(store.getOrder('ord_linkcanceled')).toBeUndefined();
    for (const kept of ['ord_linkpi', 'ord_linkvoided', 'ord_ucpfailed', 'ord_linkhooked', 'ord_linkflagged']) {
      expect(store.getOrder(kept)).toBeDefined();
    }
  });

  it('restarts from the last durable write', async () => {
    const backend = new MemoryBackend();
    const store = await PaymentsStore.memory(backend);
    store.rememberQuote(quote('qt_1', T0), T0);
    await store.insertOrder(order('ord_1', { quoteId: 'qt_1' }));
    const reopened = await PaymentsStore.memory(backend);
    expect(reopened.getOrder('ord_1')).toMatchObject({ id: 'ord_1' });
    expect(reopened.getQuote('qt_1')).toMatchObject({ id: 'qt_1' });
  });
});

describe('quotes stay in memory until an order starts', () => {
  it('a fresh quote is never written to disk; starting an order persists it in the same write', async () => {
    const backend = new MemoryBackend();
    const store = await PaymentsStore.memory(backend);
    store.rememberQuote(quote('qt_fresh', new Date(T0.getTime() + HOUR)), T0);
    store.rememberQuote(quote('qt_started', new Date(T0.getTime() + HOUR)), T0);
    expect(backend.saves).toBe(0);
    expect(store.getQuote('qt_fresh')).toMatchObject({ id: 'qt_fresh' });

    await store.insertOrder(order('ord_1', { quoteId: 'qt_started' }));
    expect(backend.saves).toBe(1);
    const onDisk = JSON.parse(backend.text ?? '{}') as { quotes: Record<string, StoredQuote> };
    expect(Object.keys(onDisk.quotes)).toEqual(['qt_started']);

    // Restart: the unstarted quote is gone (buyer re-scopes); the started one survives.
    const reopened = await PaymentsStore.memory(backend);
    expect(reopened.getQuote('qt_fresh')).toBeUndefined();
    expect(reopened.getQuote('qt_started')).toMatchObject({ id: 'qt_started' });
  });

  it('expireQuote: memory-only for a fresh quote, durable for a started one', async () => {
    const backend = new MemoryBackend();
    const store = await PaymentsStore.memory(backend);
    const later = new Date(T0.getTime() + HOUR);
    store.rememberQuote(quote('qt_fresh', later), T0);
    store.rememberQuote(quote('qt_started', later), T0);
    await store.insertOrder(order('ord_1', { quoteId: 'qt_started' }));
    const saves = backend.saves;
    await store.expireQuote('qt_fresh', T0.toISOString());
    expect(backend.saves).toBe(saves);
    expect(store.getQuote('qt_fresh')?.expiresAt).toBe(T0.toISOString());
    await store.expireQuote('qt_started', T0.toISOString());
    expect(backend.saves).toBe(saves + 1);
    expect((await PaymentsStore.memory(backend)).getQuote('qt_started')?.expiresAt).toBe(T0.toISOString());
  });

  it('is bounded: at the cap expired quotes are dropped, live ones never evicted (a flood gets undefined)', async () => {
    const store = await PaymentsStore.memory();
    const live = new Date(T0.getTime() + HOUR);
    store.rememberQuote(quote('qt_expired', T0), T0);
    for (let i = 1; i < MAX_MEMORY_QUOTES; i++) store.rememberQuote(quote(`qt_${String(i)}`, live), T0);
    const now = new Date(T0.getTime() + 1);
    expect(store.rememberQuote(quote('qt_next', live), now)).toMatchObject({ id: 'qt_next' });
    expect(store.getQuote('qt_expired')).toBeUndefined();
    // Full of live quotes: the new one is refused; nobody's live quote is evicted.
    expect(store.rememberQuote(quote('qt_flood', live), now)).toBeUndefined();
    expect(store.getQuote('qt_flood')).toBeUndefined();
    expect(store.getQuote('qt_1')).toBeDefined();
    expect(store.getQuote('qt_next')).toBeDefined();
  });

  it('prune forgets memory quotes 1h after expiry without a disk write', async () => {
    const backend = new MemoryBackend();
    const store = await PaymentsStore.memory(backend);
    store.rememberQuote(quote('qt_old', T0), T0);
    expect(await store.prune(new Date(T0.getTime() + 2 * HOUR))).toBe(1);
    expect(store.getQuote('qt_old')).toBeUndefined();
    expect(backend.saves).toBe(0);
  });
});

describe('PaymentsStore (file backend)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scopegraph-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes payments.json atomically (no tmp left) and reloads it', async () => {
    const store = await PaymentsStore.open(dir);
    store.rememberQuote(quote('qt_1', T0), T0);
    await store.insertOrder(order('ord_1', { quoteId: 'qt_1' }));
    const files = await readdir(dir);
    expect(files.sort()).toEqual(['.lock', 'payments.json']);
    const onDisk = JSON.parse(await readFile(path.join(dir, 'payments.json'), 'utf8')) as { schema: number; orders: Record<string, Order> };
    expect(onDisk.schema).toBe(1);
    expect(onDisk.orders['ord_1']?.status).toBe('authorizing');
    await store.close();
    expect(await readdir(dir)).toEqual(['payments.json']);
    const reopened = await PaymentsStore.open(dir);
    expect(reopened.getQuote('qt_1')).toBeDefined();
    await reopened.close();
  });

  it('creates DATA_DIR owner-only (0700)', async () => {
    const dataDir = path.join(dir, 'nested', 'data');
    const store = await PaymentsStore.open(dataDir);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    await store.close();
  });

  it('a symlink planted at a predictable temp path is never written through', async () => {
    const store = await PaymentsStore.open(dir);
    const victim = path.join(dir, '..', `${path.basename(dir)}-victim.txt`);
    await writeFile(victim, 'untouched');
    const planted = path.join(dir, `payments.json.${String(process.pid)}.tmp`);
    await symlink(victim, planted);
    try {
      store.rememberQuote(quote('qt_1', T0), T0);
      await store.insertOrder(order('ord_1', { quoteId: 'qt_1' }));
      expect(await readFile(victim, 'utf8')).toBe('untouched');
      const written = await lstat(path.join(dir, 'payments.json'));
      expect(written.isFile() && !written.isSymbolicLink()).toBe(true);
      expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([path.basename(planted)]);
    } finally {
      await store.close();
      await rm(victim, { force: true });
    }
  });

  const lockFile = (): string => path.join(dir, '.lock');
  // The lock is judged by real file mtimes and a real heartbeat interval (fake timers can't move
  // the filesystem clock), so these tests use short real intervals instead.
  const FAST = { heartbeatMs: 20, staleMs: 400, pollMs: 10 };

  async function writeForeignLock(pid: number, ageMs: number): Promise<void> {
    await writeFile(lockFile(), `${JSON.stringify({ pid, hostname: 'other-host', startedAt: T0.toISOString(), token: 'foreign' })}\n`);
    const at = new Date(Date.now() - ageMs);
    await utimes(lockFile(), at, at);
  }

  it('the lockfile records pid, hostname, start time; a second server sees the heartbeat and refuses', async () => {
    const store = await PaymentsStore.open(dir, FAST);
    const info = JSON.parse(await readFile(lockFile(), 'utf8')) as Record<string, unknown>;
    expect(info).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(typeof info['startedAt']).toBe('string');
    const started = Date.now();
    await expect(PaymentsStore.open(dir, { ...FAST, waitMs: 5_000 })).rejects.toThrow(/locked by another running scopegraph server/);
    // Refused on the first observed heartbeat, long before the wait ran out.
    expect(Date.now() - started).toBeLessThan(2_000);
    await store.close();
    expect(await readdir(dir)).toEqual([]);
  });

  it('the holder refreshes the lock mtime as a heartbeat', async () => {
    const store = await PaymentsStore.open(dir, FAST);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile(), old, old);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Date.now() - (await stat(lockFile())).mtimeMs).toBeLessThan(1_000);
    await store.close();
  });

  it('a fresh lock is never stolen on a pid match (containers are all pid 1)', async () => {
    await writeForeignLock(process.pid, 0);
    await expect(PaymentsStore.open(dir, { ...FAST, waitMs: 100 })).rejects.toThrow(/locked by another running/);
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ token: 'foreign' });
  });

  it('a lock whose heartbeat is older than the stale limit is taken over', async () => {
    await writeForeignLock(999_999_999, 1_000);
    const store = await PaymentsStore.open(dir, FAST);
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid, hostname: hostname() });
    await store.close();
  });

  it('a silent lock is taken over once it goes stale while boot waits', async () => {
    await writeForeignLock(process.pid, 300);
    const store = await PaymentsStore.open(dir, FAST);
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    await store.close();
  });

  it('two servers taking over one stale lock at once — exactly one wins', async () => {
    await writeForeignLock(1, 1_000);
    const results = await Promise.allSettled([PaymentsStore.open(dir, FAST), PaymentsStore.open(dir, FAST), PaymentsStore.open(dir, FAST)]);
    const winners = results.filter((r): r is PromiseFulfilledResult<PaymentsStore> => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/locked by another running/);
    await winners[0]?.value.close();
  });

  it('a takeover file left by a crashed taker is stale after the limit: removed, boot takes over', async () => {
    await writeForeignLock(1, 1_000);
    await writeFile(`${lockFile()}.takeover`, '1\n');
    const old = new Date(Date.now() - 1_000);
    await utimes(`${lockFile()}.takeover`, old, old);
    const store = await PaymentsStore.open(dir, { ...FAST, waitMs: 50 });
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(await readdir(dir)).not.toContain('.lock.takeover');
    await store.close();
  });

  it('a fresh takeover file from a crashed taker is outwaited, not misreported as a running server', async () => {
    await writeForeignLock(1, 1_000);
    await writeFile(`${lockFile()}.takeover`, '1\n');
    // waitMs is shorter than the takeover's remaining life: boot still outwaits it.
    const store = await PaymentsStore.open(dir, { ...FAST, waitMs: 50 });
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    await store.close();
  });

  it('a takeover that never finishes is reported as such (not as a live server)', async () => {
    await writeForeignLock(1, 1_000);
    const takeover = `${lockFile()}.takeover`;
    await writeFile(takeover, '1\n');
    // Keep the takeover file fresh (a real file mtime: fake timers cannot drive it).
    const keepFresh = setInterval(() => {
      const now = new Date();
      void utimes(takeover, now, now).catch(() => undefined);
    }, 20);
    try {
      await expect(PaymentsStore.open(dir, { ...FAST, waitMs: 50 })).rejects.toThrow(/takeover of its stale lock is in progress/);
    } finally {
      clearInterval(keepFresh);
    }
  });

  it('a holder whose lock was replaced refuses every further write', async () => {
    const store = await PaymentsStore.open(dir, FAST);
    await store.insertOrder(order('ord_1'));
    await writeForeignLock(1, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(store.insertOrder(order('ord_2'))).rejects.toThrow(/taken by another process/);
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ token: 'foreign' });
    await store.close();
    // Closing never deletes a lock that is not ours.
    expect(await readdir(dir)).toContain('.lock');
  });

  it('refuses a corrupt payments.json and releases the lock', async () => {
    await writeFile(path.join(dir, 'payments.json'), '{not json');
    await expect(PaymentsStore.open(dir)).rejects.toThrow(/not valid JSON/);
    expect(await readdir(dir)).toEqual(['payments.json']);
  });
});

describe('PaymentsStore lookups', () => {
  it('never reads Object.prototype keys as records', async () => {
    const store = await PaymentsStore.memory();
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(store.getQuote(id)).toBeUndefined();
      expect(store.getOrder(id)).toBeUndefined();
      expect(store.isNonceConsumed(id)).toBe(false);
      expect(store.collection('x').get(id)).toBeUndefined();
    }
  });
});
