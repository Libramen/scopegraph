import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Order } from '../types.js';
import { makeHarness } from '../orders/test-harness.js';
import type { Harness } from '../orders/test-harness.js';
import { createApprovalRouter, escapeHtml, signApprovalToken, verifyApprovalToken } from './index.js';

const SPT = 'spt_test_approval';
const HOUR = 3_600_000;

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function serve(h: Harness): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createApprovalRouter({ service: h.service, store: h.store, config: h.config, getGraph: () => h.graph.current, now: () => new Date(h.clock.now) }));
  const s = app.listen(0, '127.0.0.1');
  server = s;
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  return `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
}

async function awaitingApproval(h: Harness, buyerName = 'Ada <script>alert(1)</script>'): Promise<{ order: Order; approve: string; reject: string }> {
  const quote = await h.quote();
  const result = await h.service.payWithSpt({
    quoteId: quote.id,
    door: 'ucp',
    spt: SPT,
    buyer: { name: buyerName, email: 'ada@example.com' },
  });
  if (!result.ok || result.value.status !== 'awaiting_approval') throw new Error('fixture failed');
  await h.service.drainHooks();
  const links = h.hookCalls.find((c) => c.hook === 'onApprovalNeeded' && c.order.id === result.value.id)?.links;
  if (links === undefined) throw new Error('no links');
  const path = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };
  return { order: result.value, approve: path(links.approveUrl), reject: path(links.rejectUrl) };
}

function postForm(url: string, fields: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

function expectLockedDown(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('content-type')).toMatch(/^text\/html/);
}

describe('approval tokens', () => {
  it('bind order, action and expiry; reject tampering', () => {
    const secret = 's'.repeat(40);
    const now = new Date('2026-07-01T00:00:00Z');
    const token = signApprovalToken({ orderId: 'ord_a', action: 'approve', expiresAt: new Date(now.getTime() + HOUR), secret });
    expect(token.split('.')).toHaveLength(5);
    expect(verifyApprovalToken(token, { orderId: 'ord_a', action: 'approve', now, secret })).toMatchObject({ ok: true });
    expect(verifyApprovalToken(token, { orderId: 'ord_a', action: 'reject', now, secret })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyApprovalToken(token, { orderId: 'ord_b', action: 'approve', now, secret })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyApprovalToken(token, { orderId: 'ord_a', action: 'approve', now, secret: 't'.repeat(40) })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyApprovalToken(token, { orderId: 'ord_a', action: 'approve', now: new Date(now.getTime() + HOUR), secret })).toEqual({ ok: false, reason: 'expired' });
    const parts = token.split('.');
    const forged = [parts[0], parts[1], String(now.getTime() + 99 * HOUR), parts[3], parts[4]].join('.');
    expect(verifyApprovalToken(forged, { orderId: 'ord_a', action: 'approve', now, secret })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyApprovalToken(undefined, { orderId: 'ord_a', action: 'approve', now, secret })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('escapeHtml escapes every markup character', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('owner approval pages', () => {
  it('public status page: locked-down HTML, no PII, no answers; unknown ids 404', async () => {
    const h = await makeHarness();
    const { order } = await awaitingApproval(h);
    const base = await serve(h);
    const res = await fetch(`${base}/orders/${order.id}`);
    expect(res.status).toBe(200);
    expectLockedDown(res);
    const html = await res.text();
    expect(html).toContain('waiting for the business to confirm');
    expect(html).toContain('USD 146.00');
    expect(html).not.toContain('ada@example.com');
    expect(html).not.toContain('Ada');
    expect(html).not.toContain('participants');
    expect((await fetch(`${base}/orders/ord_aaaaaaaaaaaaaaaaaaaaaaaa`)).status).toBe(404);
    expect((await fetch(`${base}/orders/not-an-id`)).status).toBe(404);
  });

  it('GET confirmation is prefetch-safe, escaped, and shows what the owner needs', async () => {
    const h = await makeHarness();
    const { order, approve } = await awaitingApproval(h);
    const base = await serve(h);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}${approve}`);
      expect(res.status).toBe(200);
      expectLockedDown(res);
      const html = await res.text();
      expect(html).toContain('Approve this order?');
      expect(html).toContain('ada@example.com');
      expect(html).toContain('participants: 2');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)');
      expect(html).toMatch(/<form method="post" action="approve\?t=/);
    }
    expect(h.store.getOrder(order.id)?.status).toBe('awaiting_approval');
    expect(h.gateway.callsOf('capture')).toHaveLength(0);
  });

  it('POST approve captures once; the link is single-use', async () => {
    const h = await makeHarness();
    const { order, approve } = await awaitingApproval(h);
    const base = await serve(h);
    const first = await postForm(`${base}${approve}`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Approved — payment captured');
    expect(h.store.getOrder(order.id)?.status).toBe('paid');
    const replay = await postForm(`${base}${approve}`);
    expect(replay.status).toBe(409);
    const html = await replay.text();
    expect(html).toContain('already used');
    expect(html).toContain(`scopegraph orders approve ${order.id}`);
    expect(html).toContain('Paid');
    const reGet = await fetch(`${base}${approve}`);
    expect(reGet.status).toBe(409);
    expect(h.gateway.callsOf('capture')).toHaveLength(1);
  });

  it('POST reject stores the optional reason; approve token cannot reject', async () => {
    const h = await makeHarness();
    const { order, approve, reject } = await awaitingApproval(h);
    const base = await serve(h);
    const wrongAction = approve.replace('/approve?', '/reject?');
    const wrong = await postForm(`${base}${wrongAction}`);
    expect(wrong.status).toBe(403);
    expect(h.store.getOrder(order.id)?.status).toBe('awaiting_approval');

    const res = await postForm(`${base}${reject}`, { reason: 'Fully booked that day' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Rejected');
    expect(h.store.getOrder(order.id)).toMatchObject({ status: 'rejected', statusReason: 'Fully booked that day' });
  });

  it('expired and tampered links are refused with the current status and the CLI hint', async () => {
    const h = await makeHarness();
    const { order, approve } = await awaitingApproval(h);
    const base = await serve(h);
    const tampered = approve.replace(/t=([^&]+)/, (_m, t: string) => `t=${t.slice(0, -2)}xx`);
    const bad = await postForm(`${base}${tampered}`);
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('not valid');
    h.clock.advance(24 * HOUR);
    const expired = await postForm(`${base}${approve}`);
    expect(expired.status).toBe(403);
    const html = await expired.text();
    expect(html).toContain('expired');
    expect(html).toContain(`scopegraph orders approve ${order.id}`);
    expect(h.gateway.callsOf('capture')).toHaveLength(0);
  });

  it('a link for a decided order shows its status (no action)', async () => {
    const h = await makeHarness();
    const { order, approve } = await awaitingApproval(h);
    await h.service.reject(order.id);
    const base = await serve(h);
    const res = await fetch(`${base}${approve}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Nothing to decide');
    const post = await postForm(`${base}${approve}`);
    expect(post.status).toBe(409);
    expect(h.store.getOrder(order.id)?.status).toBe('rejected');
  });
});

describe('admin API', () => {
  async function adminFetch(url: string, token: string | undefined, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  }

  it('requires the bearer token', async () => {
    const h = await makeHarness();
    const base = await serve(h);
    const none = await adminFetch(`${base}/admin/orders`, undefined);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect((await adminFetch(`${base}/admin/orders`, 'wrong')).status).toBe(401);
    expect((await adminFetch(`${base}/admin/orders`, `${h.config.adminToken}x`)).status).toBe(401);
    expect((await adminFetch(`${base}/admin/orders/ord_aaaaaaaaaaaaaaaaaaaaaaaa/approve`, undefined, { method: 'POST' })).status).toBe(401);
  });

  it('lists, shows (with buyer), approves and rejects', async () => {
    const h = await makeHarness();
    const a = await awaitingApproval(h);
    const b = await awaitingApproval(h);
    const base = await serve(h);
    const token = h.config.adminToken;

    const list = await adminFetch(`${base}/admin/orders?status=awaiting_approval`, token);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(((await list.json()) as { orders: Order[] }).orders.map((o) => o.id).sort()).toEqual([a.order.id, b.order.id].sort());
    expect((await adminFetch(`${base}/admin/orders?status=bogus`, token)).status).toBe(400);

    const show = (await (await adminFetch(`${base}/admin/orders/${a.order.id}`, token)).json()) as { order: Order };
    expect(show.order.buyer?.email).toBe('ada@example.com');
    expect((await adminFetch(`${base}/admin/orders/ord_aaaaaaaaaaaaaaaaaaaaaaaa`, token)).status).toBe(404);

    const approved = await adminFetch(`${base}/admin/orders/${a.order.id}/approve`, token, { method: 'POST' });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { order: Order }).order.status).toBe('paid');

    const badReason = await adminFetch(`${base}/admin/orders/${b.order.id}/reject`, token, { method: 'POST', body: JSON.stringify({ reason: 42 }) });
    expect(badReason.status).toBe(400);
    const rejected = await adminFetch(`${base}/admin/orders/${b.order.id}/reject`, token, { method: 'POST', body: JSON.stringify({ reason: 'No staff' }) });
    expect(((await rejected.json()) as { order: Order }).order).toMatchObject({ status: 'rejected', statusReason: 'No staff' });

    const conflict = await adminFetch(`${base}/admin/orders/${b.order.id}/approve`, token, { method: 'POST' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'invalid_state' });
  });
});
