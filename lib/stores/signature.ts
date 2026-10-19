import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authentication for store platforms.
 *
 * Salla (docs): X-Salla-Security-Strategy is signature | token | none.
 *   signature: X-Salla-Signature = hex HMAC-SHA256(secret, raw body).
 *   token: a shared token the merchant configured (header name/format is
 *   inconsistent in the docs, so we accept the Authorization bearer value or
 *   an X-Salla-Token header and compare constant-time). UNVERIFIED live.
 *   none: never accepted here, an unauthenticated order feed is refused.
 *
 * Zid (docs): NO HMAC signature is documented. The only delivery
 * authentication is optional Basic Auth (username/password given when the
 * webhook is created). We additionally require a secret in the target URL.
 * This is weaker than HMAC (no body integrity) and is flagged as a limitation.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySallaWebhook(args: {
  secret: string;
  strategy: string | null;
  signature: string | null;
  authorization?: string | null;
  tokenHeader?: string | null;
  rawBody: string;
}): VerifyResult {
  const strategy = (args.strategy ?? 'signature').toLowerCase();
  if (strategy === 'none') return { ok: false, reason: 'unauthenticated_strategy' };
  if (strategy === 'token') {
    const presented = (args.tokenHeader ?? args.authorization?.replace(/^Bearer\s+/i, '') ?? '').trim();
    if (!presented) return { ok: false, reason: 'token_missing' };
    return safeEqual(presented, args.secret) ? { ok: true } : { ok: false, reason: 'token_mismatch' };
  }
  if (strategy !== 'signature') return { ok: false, reason: 'unknown_strategy' };
  const sig = (args.signature ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'signature_missing' };
  const expected = createHmac('sha256', args.secret).update(args.rawBody, 'utf8').digest('hex');
  return safeEqual(sig, expected) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

export function sallaSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifyZidWebhook(args: {
  urlSecret: string;
  presentedUrlSecret: string | null;
  username: string;
  password: string;
  authorization: string | null;
}): VerifyResult {
  if (!args.presentedUrlSecret || !safeEqual(args.presentedUrlSecret, args.urlSecret)) {
    return { ok: false, reason: 'url_secret_mismatch' };
  }
  const m = /^Basic\s+(.+)$/i.exec(args.authorization ?? '');
  if (!m) return { ok: false, reason: 'basic_missing' };
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return safeEqual(decoded, `${args.username}:${args.password}`) ? { ok: true } : { ok: false, reason: 'basic_mismatch' };
}
