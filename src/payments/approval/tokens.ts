/**
 * Owner approval links: `<orderId>.<action>.<expMs>.<nonce>.<hmac>`,
 * HMAC-SHA256 keyed by ORDER_SIGNING_SECRET, bound to one order and one
 * action, expiring at the approval deadline. Single use is enforced by the
 * store (`claimNonce`) when the POST acts — never on GET.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type ApprovalAction = 'approve' | 'reject';

export interface ApprovalLinks {
  approveUrl: string;
  rejectUrl: string;
  /** Public status page (no PII). */
  statusUrl: string;
  /** Link expiry (= approval deadline). */
  expiresAt: string;
}

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signApprovalToken(input: { orderId: string; action: ApprovalAction; expiresAt: Date; secret: string }): string {
  const payload = `${input.orderId}.${input.action}.${String(input.expiresAt.getTime())}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${mac(input.secret, payload)}`;
}

export type TokenCheck =
  | { ok: true; nonce: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Verify a token for exactly this order and action. A token for the other
 * action, another order, a bad MAC or a malformed string are all `invalid`
 * (no oracle distinguishing them).
 */
export function verifyApprovalToken(
  token: unknown,
  expected: { orderId: string; action: ApprovalAction; now: Date; secret: string },
): TokenCheck {
  if (typeof token !== 'string' || token.length > 256) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'invalid' };
  const [orderId, action, exp, nonce, signature] = parts as [string, string, string, string, string];
  const expected_ = Buffer.from(mac(expected.secret, `${orderId}.${action}.${exp}.${nonce}`));
  const given = Buffer.from(signature);
  if (given.length !== expected_.length || !timingSafeEqual(given, expected_)) return { ok: false, reason: 'invalid' };
  if (orderId !== expected.orderId || action !== expected.action || !/^\d+$/.test(exp)) return { ok: false, reason: 'invalid' };
  const expiresAt = new Date(Number(exp));
  if (expiresAt.getTime() <= expected.now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, nonce, expiresAt };
}

/** Fresh approve/reject links for an order awaiting approval. */
export function approvalLinks(input: { orderId: string; deadline: Date; publicUrl: string; secret: string }): ApprovalLinks {
  const base = `${input.publicUrl}/orders/${input.orderId}`;
  const token = (action: ApprovalAction): string =>
    encodeURIComponent(signApprovalToken({ orderId: input.orderId, action, expiresAt: input.deadline, secret: input.secret }));
  return {
    approveUrl: `${base}/approve?t=${token('approve')}`,
    rejectUrl: `${base}/reject?t=${token('reject')}`,
    statusUrl: base,
    expiresAt: input.deadline.toISOString(),
  };
}
