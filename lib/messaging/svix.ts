import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix signature check, which is how Resend signs its webhooks.
 *
 * Headers: svix-id, svix-timestamp (seconds), svix-signature (space separated
 * "v1,<base64>" entries; several appear while a secret is being rotated).
 * The signed content is `${id}.${timestamp}.${rawBody}`, the key is the base64
 * part of the endpoint secret ("whsec_<base64>"), the signature is
 * base64(HMAC-SHA256). Requests more than five minutes away from now are
 * refused, which is what stops a captured request being replayed later.
 */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'timestamp_out_of_range'
  | 'bad_secret'
  | 'no_match';

export function verifySvixSignature(input: {
  secret: string;
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  /** Test seam. */
  nowMs?: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: SvixFailure } {
  const { secret, id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const sentAt = Number(timestamp);
  const nowSeconds = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - sentAt) > (input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const key = Buffer.from(secret.trim().replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return { ok: false, reason: 'bad_secret' };

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();

  for (const entry of signature.split(/\s+/)) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    if (entry.slice(0, comma) !== 'v1') continue;
    const received = Buffer.from(entry.slice(comma + 1), 'base64');
    if (received.length === expected.length && timingSafeEqual(received, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no_match' };
}
