/**
 * Approval deadline: the latest moment the owner may still approve (capture).
 *
 *   min(now + approvalWindowHours, serviceStart − 1h, capture_before − 1h)
 *
 * serviceStart = the requested date-time, or the first instant of the
 * requested day in the business timezone (date-only); no date ⇒ ignored.
 * capture_before = when Stripe auto-releases the uncaptured charge; absent ⇒
 * ignored. A deadline less than 5 minutes away is too soon to ask the owner:
 * the hold is voided (`canceled`, `date_too_soon`).
 */
import type { Business } from '../../graph/types.js';
import { analyzeDate } from '../../engine/derived.js';

const HOUR_MS = 3_600_000;
export const MIN_APPROVAL_LEAD_MS = 5 * 60_000;

export function computeApprovalDeadline(input: {
  now: Date;
  approvalWindowHours: number;
  date?: string;
  business: Business;
  captureBefore?: string;
}): Date {
  let deadline = input.now.getTime() + input.approvalWindowHours * HOUR_MS;
  if (input.date !== undefined) {
    const start = analyzeDate(input.date, input.now, input.business)?.start;
    if (start !== undefined) deadline = Math.min(deadline, start.getTime() - HOUR_MS);
  }
  if (input.captureBefore !== undefined) {
    const captureBefore = Date.parse(input.captureBefore);
    if (Number.isFinite(captureBefore)) deadline = Math.min(deadline, captureBefore - HOUR_MS);
  }
  return new Date(deadline);
}
