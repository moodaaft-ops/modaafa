import { createHmac, timingSafeEqual } from 'node:crypto';
import { isConfiguredEnv } from '@/lib/platform/env';

/**
 * Signed one-click unsubscribe links for follow-up emails.
 *
 * The link carries the user id and an HMAC of it, so nobody can opt another
 * person out by guessing an id. The secret is MESSAGES_UNSUBSCRIBE_SECRET; it
 * is deliberately NOT the cron secret, because this value ends up inside
 * emails that people forward.
 */
const APP_ORIGIN = 'https://ai.modaafa.com';

export function unsubscribeToken(userId: string, secret = process.env.MESSAGES_UNSUBSCRIBE_SECRET): string | null {
  if (!isConfiguredEnv(secret)) return null;
  return createHmac('sha256', secret.trim()).update(`unsubscribe:${userId}`).digest('hex');
}

export function verifyUnsubscribeToken(
  userId: string,
  token: string,
  secret = process.env.MESSAGES_UNSUBSCRIBE_SECRET
): boolean {
  const expected = unsubscribeToken(userId, secret);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unsubscribeUrl(userId: string, secret = process.env.MESSAGES_UNSUBSCRIBE_SECRET): string | null {
  const token = unsubscribeToken(userId, secret);
  if (!token) return null;
  return `${APP_ORIGIN}/api/messages/unsubscribe?u=${encodeURIComponent(userId)}&t=${token}`;
}
