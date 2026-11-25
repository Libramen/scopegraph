/**
 * Default order hooks: one stderr line each, never the signed approve/reject links (anyone
 * holding one can act on the order) and never raw buyer control characters (terminal escapes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onApprovalNeeded, onPaid } from './orders.js';
import type { Order } from '../payments/types.js';

const order: Order = {
  id: 'ord_abcdefghijklmnopqrstuvwx',
  quoteId: 'qt_abcdefghijklmnopqrstuvwx',
  offering: 'surf-lesson',
  request: { answers: {}, selections: {} },
  quote: { currency: 'usd', lines: [], subtotalCents: 7300, taxCents: 0, totalCents: 7300 },
  confirmation: 'owner_approves',
  door: 'ucp',
  createdAt: '2026-11-20T12:00:00.000Z',
  stripe: {},
  status: 'awaiting_approval',
  buyer: { name: 'Ada\u001b[1A\u001b[2K', email: 'ada@example.com\u001b]52;c;cGF5bG9hZA==\u0007' },
  pendingHooks: [],
  version: 0,
};

function printed(calls: unknown[][]): string {
  return calls.map((args) => args.map(String).join(' ')).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('default order hooks', () => {
  it('onApprovalNeeded prints the order id, total, deadline and CLI hint — never the signed links or buyer text', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await onApprovalNeeded(order, {
      approveUrl: 'https://pay.example/orders/ord_abcdefghijklmnopqrstuvwx/approve?t=secret-approve-token',
      rejectUrl: 'https://pay.example/orders/ord_abcdefghijklmnopqrstuvwx/reject?t=secret-reject-token',
      expiresAt: '2026-11-21T12:00:00.000Z',
      statusUrl: 'https://pay.example/orders/ord_abcdefghijklmnopqrstuvwx',
    });
    const out = printed(spy.mock.calls);
    expect(out).toContain('ord_abcdefghijklmnopqrstuvwx');
    expect(out).toContain('usd 73.00');
    expect(out).toContain('2026-11-21T12:00:00.000Z');
    expect(out).toContain('npm run sg -- orders approve ord_abcdefghijklmnopqrstuvwx');
    expect(out).not.toContain('secret-approve-token');
    expect(out).not.toContain('secret-reject-token');
    expect(out).not.toContain('?t=');
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('onPaid prints buyer text with control characters stripped', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await onPaid({ ...order, status: 'paid' });
    const out = printed(spy.mock.calls);
    expect(out).toContain('ada@example.com]52;c;cGF5bG9hZA==');
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
