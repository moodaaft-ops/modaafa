import crypto from 'crypto';

/**
 * Encryption utilities for sensitive data (refresh tokens, secrets).
 * Uses AES-256-GCM with a 32-byte key from ENCRYPTION_KEY env var.
 *
 * In production, the ENCRYPTION_KEY should be stored in AWS KMS / GCP Secret Manager.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY env var is not set');
  }
  // Decode base64 — must be exactly 32 bytes
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}. Generate with: openssl rand -base64 32`
    );
  }
  return buf;
}

/** Encrypt a string and return base64(iv || tag || ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt the base64 payload produced by encrypt(). */
export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
