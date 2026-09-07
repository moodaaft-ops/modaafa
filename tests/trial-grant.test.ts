import assert from 'node:assert/strict';
import test from 'node:test';
import { recordTrialGrant, trialLedgerKey } from '../lib/billing/checkout-policy';

function database(fail?: 'identity' | 'ledger') {
  const writes: string[] = [];
  return {
    writes,
    auth: { admin: { getUserById: async () => ({
      data: { user: { email: 'verified@example.com' } },
      error: fail === 'identity' ? new Error('identity unavailable') : null,
    }) } },
    from(table: string) {
      return { upsert: async (row: any) => {
        writes.push(table);
        if (table === 'billing_trial_ledger') assert.equal(row.email_hash, trialLedgerKey('verified@example.com'));
        return { error: table === 'billing_trial_ledger' && fail === 'ledger' ? new Error('ledger unavailable') : null };
      } };
    },
  };
}

test('trial grants persist the verified identity in the durable ledger before the per-user grant', async () => {
  const db = database();
  await recordTrialGrant({ supabase: db, userId: 'user-1', source: 'stripe_webhook' }, () => db as any);
  assert.deepEqual(db.writes, ['billing_trial_ledger', 'billing_trial_grants']);
});

for (const failure of ['identity', 'ledger'] as const) {
  test(`trial ${failure} failure is retryable instead of acknowledged as complete`, async () => {
    const db = database(failure);
    await assert.rejects(recordTrialGrant({
      supabase: db, userId: 'user-1', source: 'stripe_webhook',
    }, () => db as any), /unavailable/);
    assert.equal(db.writes.includes('billing_trial_grants'), false);
  });
}
