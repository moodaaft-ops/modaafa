import assert from 'node:assert/strict';
import test from 'node:test';
import { hasActiveGoogleAdsAccount } from '../lib/accounts/selection';

/** businesses -> maybeSingle; google_ads_accounts -> awaited list. */
function fakeSupabase({
  business = { id: 'b1' } as any,
  accounts = [] as any[],
  accountError = null as any,
}) {
  const seen: Array<[string, unknown]> = [];
  const client = {
    seen,
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq(column: string, value: unknown) {
          if (table === 'google_ads_accounts') seen.push([column, value]);
          return builder;
        },
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: table === 'businesses' ? business : null, error: null }),
        then: (resolve: any) => resolve({ data: accounts, error: accountError }),
      };
      return builder;
    },
  };
  return client;
}

test('an active linked account passes the trial gate and only active rows are requested', async () => {
  const supabase = fakeSupabase({ accounts: [{ id: 'a1', customer_id: '111-111-1111' }] });
  assert.equal(await hasActiveGoogleAdsAccount(supabase, 'u1'), true);
  assert.deepEqual(supabase.seen.filter(([column]) => column === 'status'), [['status', 'active']]);
});

test('no active account (or no business) blocks the trial', async () => {
  assert.equal(await hasActiveGoogleAdsAccount(fakeSupabase({ accounts: [] }), 'u1'), false);
  assert.equal(await hasActiveGoogleAdsAccount(fakeSupabase({ business: null }), 'u1'), false);
});

test('a failed account lookup fails open so payments are not blocked by a DB blip', async () => {
  const supabase = fakeSupabase({ accountError: { message: 'timeout' } });
  assert.equal(await hasActiveGoogleAdsAccount(supabase, 'u1'), true);
});
