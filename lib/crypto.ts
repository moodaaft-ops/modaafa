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
const CURRENT_VERSION = 'v1';

export type DecryptionDetails = {
  plaintext: string;
  usedPreviousKey: boolean;
  legacyFormat: boolean;
  needsReencryption: boolean;
};

function decodeKey(value: string | undefined, envName: string): Buffer {
  if (!value) {
    throw new Error(`${envName} env var is not set`);
  }

  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `${envName} must decode to 32 bytes, got ${buf.length}. Generate with: openssl rand -base64 32`
    );
  }
  return buf;
}

function getCurrentKey(): Buffer {
  return decodeKey(process.env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
}

function getPreviousKey(): Buffer | undefined {
  const value = process.env.ENCRYPTION_KEY_PREVIOUS;
  return value ? decodeKey(value, 'ENCRYPTION_KEY_PREVIOUS') : undefined;
}

function parsePayload(payload: string): { encoded: string; legacyFormat: boolean } {
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { encoded: payload, legacyFormat: true };
  }

  const version = payload.slice(0, separatorIndex);
  if (version !== CURRENT_VERSION) {
    throw new Error(`Unsupported encrypted payload version: ${version || '(empty)'}`);
  }

  return {
    encoded: payload.slice(separatorIndex + 1),
    legacyFormat: false,
  };
}

function decryptWithKey(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload is invalid');
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Encrypt a string using the current key and versioned payload format. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getCurrentKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encoded = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  return `${CURRENT_VERSION}:${encoded}`;
}

/**
 * Decrypt a payload with the current key, then the read-only previous key.
 * Legacy payloads without a prefix are treated as v1.
 */
export function decryptForRotation(payload: string): DecryptionDetails {
  const { encoded, legacyFormat } = parsePayload(payload);
  let currentKeyError: unknown;

  try {
    return {
      plaintext: decryptWithKey(encoded, getCurrentKey()),
      usedPreviousKey: false,
      legacyFormat,
      needsReencryption: legacyFormat,
    };
  } catch (error) {
    currentKeyError = error;
  }

  const previousKey = getPreviousKey();
  if (previousKey) {
    try {
      return {
        plaintext: decryptWithKey(encoded, previousKey),
        usedPreviousKey: true,
        legacyFormat,
        needsReencryption: true,
      };
    } catch {
      // Fall through to the stable error below.
    }
  }

  const error = new Error('Unable to decrypt payload with configured encryption keys');
  error.cause = currentKeyError;
  throw error;
}

/** Decrypt either a versioned payload or a legacy unprefixed v1 payload. */
export function decrypt(payload: string): string {
  return decryptForRotation(payload).plaintext;
}
