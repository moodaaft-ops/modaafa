import { createHmac, timingSafeEqual } from 'node:crypto';
import { isConfiguredEnv } from '@/lib/platform/env';

/**
 * Signed unsubscribe links. The token is an HMAC of the user id, so a link
 * can only stop messages for the person it was sent to and nobody can guess
 * another user's link. No expiry on purpose: an old email must still work.
 *
 * Key: UNSUBSCRIBE_SECRET when set, otherwise CRON_SECRET (already required in
 * production). The prefix keeps the two uses from ever producing the same
 * signature.
 */
function secret() {
  const own = process.env.UNSUBSCRIBE_SECRET;
  if (isConfiguredEnv(own)) return own.trim();
  const cron = process.env.CRON_SECRET;
  if (isConfiguredEnv(cron)) return cron.trim();
  return null;
}

function sign(userId: string, key: string) {
  return createHmac('sha256', key).update(`messages_opt_out:${userId}`).digest('base64url');
}

export function appBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  return (isConfiguredEnv(configured) ? configured.trim() : 'https://ai.modaafa.com').replace(/\/+$/, '');
}

/** Returns null when no signing key is configured (the caller must not send). */
export function buildOptOutUrl(userId: string) {
  const key = secret();
  if (!key) return null;
  const params = new URLSearchParams({ u: userId, t: sign(userId, key) });
  return `${appBaseUrl()}/api/messages/opt-out?${params.toString()}`;
}

export function verifyOptOutToken(userId: string | null, token: string | null) {
  const key = secret();
  if (!key || !userId || !token) return false;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
  const expected = Buffer.from(sign(userId, key));
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
