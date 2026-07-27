import assert from 'node:assert/strict';
import test from 'node:test';

import { decrypt, decryptForRotation, encrypt } from '../lib/crypto';

const KEY_A = Buffer.alloc(32, 0x11).toString('base64');
const KEY_B = Buffer.alloc(32, 0x22).toString('base64');

test('encrypt emits a v1 payload and decrypt reads it', () => {
  withKeys(KEY_A, undefined, () => {
    const payload = encrypt('refresh-token-v1');
    assert.ok(payload.startsWith('v1:'));
    assert.equal(decrypt(payload), 'refresh-token-v1');

    const details = decryptForRotation(payload);
    assert.equal(details.legacyFormat, false);
    assert.equal(details.usedPreviousKey, false);
    assert.equal(details.needsReencryption, false);
  });
});

test('decrypt accepts legacy v1 payloads without a prefix', () => {
  withKeys(KEY_A, undefined, () => {
    const legacyPayload = encrypt('legacy-refresh-token').slice('v1:'.length);
    assert.equal(decrypt(legacyPayload), 'legacy-refresh-token');

    const details = decryptForRotation(legacyPayload);
    assert.equal(details.legacyFormat, true);
    assert.equal(details.usedPreviousKey, false);
    assert.equal(details.needsReencryption, true);
  });
});

test('decrypt falls back to ENCRYPTION_KEY_PREVIOUS for rotation', () => {
  let payload = '';
  withKeys(KEY_A, undefined, () => {
    payload = encrypt('token-under-previous-key');
  });

  withKeys(KEY_B, KEY_A, () => {
    const details = decryptForRotation(payload);
    assert.equal(details.plaintext, 'token-under-previous-key');
    assert.equal(details.usedPreviousKey, true);
    assert.equal(details.needsReencryption, true);
  });
});

test('decrypt fails cleanly when neither configured key matches', () => {
  let payload = '';
  withKeys(KEY_A, undefined, () => {
    payload = encrypt('unreadable-with-key-b');
  });

  withKeys(KEY_B, undefined, () => {
    assert.throws(
      () => decrypt(payload),
      /Unable to decrypt payload with configured encryption keys/
    );
  });
});

function withKeys(current: string, previous: string | undefined, callback: () => void) {
  const originalCurrent = process.env.ENCRYPTION_KEY;
  const originalPrevious = process.env.ENCRYPTION_KEY_PREVIOUS;

  process.env.ENCRYPTION_KEY = current;
  if (previous) process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  else delete process.env.ENCRYPTION_KEY_PREVIOUS;

  try {
    callback();
  } finally {
    restoreEnv('ENCRYPTION_KEY', originalCurrent);
    restoreEnv('ENCRYPTION_KEY_PREVIOUS', originalPrevious);
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
