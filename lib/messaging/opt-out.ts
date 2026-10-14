import { createHmac, timingSafeEqual } from 'node:crypto';
import { isConfiguredEnv } from '@/lib/platform/env';

/**
 * Signed email links. The token is an HMAC of a prefix plus the value being
 * protected, so a link can only act for the person it was sent to and nobody
 * can guess another user's link. No expiry on purpose: an old email must
 * still work.
 *
 * Key: UNSUBSCRIBE_SECRET when set, otherwise CRON_SECRET (already required in
 * production). Each use has its own prefix (messages_opt_out, email_prefs,
 * email_click) so a token minted for one purpose never verifies for another.
 */
function secret() {
  const own = process.env.UNSUBSCRIBE_SECRET;
  if (isConfiguredEnv(own)) return own.trim();
  const cron = process.env.CRON_SECRET;
  if (isConfiguredEnv(cron)) return cron.trim();
  return null;
}

/** True when links can be signed at all (the caller must not send a mail without them). */
export function signingConfigured() {
  return secret() !== null;
}

/** HMAC of `prefix:value`, or null when no signing key is configured. */
export function signValue(prefix: string, value: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac('sha256', key).update(`${prefix}:${value}`).digest('base64url');
}

/** Constant-time check of a token made by `signValue`. */
export function verifySignedValue(prefix: string, value: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = signValue(prefix, value);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function appBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  return (isConfiguredEnv(configured) ? configured.trim() : 'https://ai.modaafa.com').replace(/\/+$/, '');
}

/** Returns null when no signing key is configured (the caller must not send). */
export function buildOptOutUrl(userId: string) {
  const token = signValue('messages_opt_out', userId);
  if (!token) return null;
  const params = new URLSearchParams({ u: userId, t: token });
  return `${appBaseUrl()}/api/messages/opt-out?${params.toString()}`;
}

export function verifyOptOutToken(userId: string | null, token: string | null) {
  if (!userId || !token) return false;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
  return verifySignedValue('messages_opt_out', userId, token);
}
