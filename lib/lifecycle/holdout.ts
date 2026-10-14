import { createHash } from 'node:crypto';
import { HOLDOUT_PERCENT } from '@/config/email-journeys';

/**
 * Stable holdout group: the same user is always in or always out, on every
 * server, forever, with no table to store it. sha256 of the user id, first four
 * bytes as a big-endian unsigned integer, modulo 100, compared to the percent.
 *
 * Users in the holdout receive no journey mail (welcome, transactional,
 * past_due and the weekly report still reach them), which is what lets the
 * funnel report compare "got the emails" against "did not" honestly.
 *
 * The funnel report (/operations/funnel) uses this same function to split
 * recipients from holdout users, so do not change the hash without changing
 * the meaning of every past comparison.
 */
export function isHoldout(userId: string, percent: number = HOLDOUT_PERCENT): boolean {
  if (!(percent > 0)) return false;
  const digest = createHash('sha256').update(userId).digest();
  return digest.readUInt32BE(0) % 100 < percent;
}
