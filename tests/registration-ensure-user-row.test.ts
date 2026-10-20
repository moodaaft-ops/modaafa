import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { finalizeForRequest } from '../lib/registration/service';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'a@example.com', user_metadata: { full_name: 'اسم تجريبي', reg: { phone: '0500000000' } } };

test('the profile row is ensured before finalize runs, so the email link does not hit no_user', async () => {
  const order: string[] = [];
  const outcome = await finalizeForRequest(
    new NextRequest('https://ai.modaafa.com/register/finish'),
    USER,
    undefined,
    {
      ensureUserRow: async () => {
        order.push('ensure');
      },
      db: {
        rpc: async (fn) => {
          order.push(fn);
          return { data: [{ result_status: 'completed', result_registered_at: null }], error: null };
        },
      },
      sendServerEvent: async () => ({ status: 'sent', testMode: false }),
      sendWelcome: () => {},
      attachReferral: async () => {},
    },
  );
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(order.slice(0, 2), ['ensure', 'finalize_registration']);
});
