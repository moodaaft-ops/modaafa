import { createHash } from 'node:crypto';

/**
 * Stable holdout group: the same user is always in or always out, with no table
 * to store it. sha256 of the user id, first four bytes as a big-endian unsigned
 * integer, modulo 100, compared to the percent (default 10).
 *
 * Users in the holdout receive no journey mail, which is what lets the funnel
 * report compare "got the emails" against "did not" honestly. Do not change the
 * hash without changing the meaning of every past comparison.
 */
export function isHoldout(userId: string, percent: number = 10): boolean {
  if (!(percent > 0)) return false;
  const digest = createHash('sha256').update(userId).digest();
  return digest.readUInt32BE(0) % 100 < percent;
}
