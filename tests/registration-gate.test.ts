import assert from 'node:assert/strict';
import test from 'node:test';
import { isRegistrationComplete } from '../lib/registration/gate';

const reader = (result: unknown, throws = false) => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          if (throws) throw new Error('down');
          return result;
        },
      }),
    }),
  }),
});

test('registered users pass, unregistered users are held', async () => {
  assert.equal(await isRegistrationComplete(reader({ data: { registered_at: '2026-10-12T00:00:00Z' }, error: null }), 'u'), true);
  assert.equal(await isRegistrationComplete(reader({ data: { registered_at: null }, error: null }), 'u'), false);
});

test('a read failure lets people in rather than locking out paying customers', async () => {
  assert.equal(await isRegistrationComplete(reader({ data: null, error: { message: 'column missing' } }), 'u'), true);
  assert.equal(await isRegistrationComplete(reader(null, true), 'u'), true);
});

test('a signed-in user with no profile row still owes their details', async () => {
  assert.equal(await isRegistrationComplete(reader({ data: null, error: null }), 'u'), false);
});
