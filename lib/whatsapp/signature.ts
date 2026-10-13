import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook POST with the app secret and sends the result in
 * `X-Hub-Signature-256` as "sha256=<hex>". The HMAC must be computed over the
 * raw request bytes, so callers read the body as text before parsing JSON.
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(match[1], 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Constant-time string comparison for the GET handshake verify token. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
