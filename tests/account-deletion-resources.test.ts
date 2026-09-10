import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAccountDeletionResources } from '../lib/accounts/deletion-resources';

function database(failingTable?: string, accountCount = 1) {
  const reads: string[] = [];
  const tables: Record<string, any[]> = {
    subscriptions: [{ id: 'sub-1', stripe_subscription_id: 'sub_test' }],
    businesses: [{ id: 'business-1' }],
    google_ads_accounts: Array.from({ length: accountCount }, (_, i) => ({
      id: String(i), refresh_token_encrypted: `encrypted-${i}`,
    })),
  };
  return { reads, from(table: string) {
    return {
      select() { return this; },
      eq(key: string, value: string) {
        assert.equal(value, key === 'user_id' ? 'user-1' : 'business-1');
        return this;
      },
      in() { return this; },
      order(key: string) { assert.equal(key, 'id'); return this; },
      async range(start: number, end: number) {
        reads.push(table);
        return table === failingTable
          ? { data: null, error: { message: 'unavailable' } }
          : { data: tables[table].slice(start, end + 1), error: null };
      },
    };
  } };
}

for (const table of ['subscriptions', 'businesses', 'google_ads_accounts']) {
  test(`a failed ${table} read blocks deletion instead of pretending no grants exist`, async () => {
    await assert.rejects(loadAccountDeletionResources(database(table), 'user-1'), /inventory/);
  });
}

test('deletion reads every page, including accounts beyond the database response cap', async () => {
  const db = database(undefined, 1101);
  const inventory = await loadAccountDeletionResources(db, 'user-1');
  assert.equal(inventory.adAccounts.length, 1101);
  assert.equal(inventory.adAccounts[1100].refresh_token_encrypted, 'encrypted-1100');
  assert.equal(db.reads.filter((table) => table === 'google_ads_accounts').length, 3);
});
