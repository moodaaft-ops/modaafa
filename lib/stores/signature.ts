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
 * The URL secret is per store (HMAC of the env secret and the store id), so a
 * merchant who can read their own webhook URL cannot post orders for another store.
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

/** The `s=` value for one Zid store's webhook URL: hex HMAC-SHA256(ZID_WEBHOOK_URL_SECRET, "zid:<store id>"). */
export function zidStoreUrlSecret(urlSecret: string, storeId: string): string {
  return createHmac('sha256', urlSecret).update(`zid:${storeId}`, 'utf8').digest('hex');
}

export function verifyZidWebhook(args: {
  urlSecret: string;
  presentedUrlSecret: string | null;
  /** The ?store= value. The URL secret is bound to it. */
  storeId: string | null;
  username: string;
  password: string;
  authorization: string | null;
}): VerifyResult {
  if (!args.storeId || !/^[A-Za-z0-9_-]{1,64}$/.test(args.storeId)) return { ok: false, reason: 'store_missing' };
  const expected = zidStoreUrlSecret(args.urlSecret, args.storeId);
  if (!args.presentedUrlSecret || !safeEqual(args.presentedUrlSecret.toLowerCase(), expected)) {
    return { ok: false, reason: 'url_secret_mismatch' };
  }
  const m = /^Basic\s+(.+)$/i.exec(args.authorization ?? '');
  if (!m) return { ok: false, reason: 'basic_missing' };
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return safeEqual(decoded, `${args.username}:${args.password}`) ? { ok: true } : { ok: false, reason: 'basic_mismatch' };
}

/**
 * Shopify: X-Shopify-Hmac-Sha256 = base64 HMAC-SHA256(app client secret, raw body).
 * (Documented by Shopify; compare constant-time on the raw bytes.)
 */
export function verifyShopifyWebhook(args: { secret: string; hmacHeader: string | null; rawBody: string }): VerifyResult {
  const presented = (args.hmacHeader ?? '').trim();
  if (!presented) return { ok: false, reason: 'signature_missing' };
  const expected = createHmac('sha256', args.secret).update(args.rawBody, 'utf8').digest('base64');
  return safeEqual(presented, expected) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

export function shopifyHmac(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/**
 * Shopify OAuth redirect: `hmac` = hex HMAC-SHA256(client secret, the other
 * query params sorted by key, joined as key=value with &). Verified before the
 * code is used, so a forged redirect cannot start an install.
 */
export function verifyShopifyQuery(secret: string, params: URLSearchParams): VerifyResult {
  const hmac = params.get('hmac');
  if (!hmac || !/^[0-9a-f]{64}$/i.test(hmac)) return { ok: false, reason: 'hmac_missing' };
  const message = [...params.entries()]
    .filter(([k]) => k !== 'hmac')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const expected = createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  return safeEqual(hmac.toLowerCase(), expected) ? { ok: true } : { ok: false, reason: 'hmac_mismatch' };
}
