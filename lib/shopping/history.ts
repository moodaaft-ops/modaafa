import type { ShoppingHealth } from './reader';
import { addDaysYmd } from '../guard/time';
export const shoppingHistoryEnabled = (env: NodeJS.ProcessEnv = process.env) => env.SHOPPING_FEED_SNAPSHOTS_ENABLED === 'true';
/** Compare with yesterday before replacing today's row. No product IDs or customer data. */
export async function saveFeedSnapshot(db: any, accountId: string, date: string, feed: ShoppingHealth): Promise<ShoppingHealth | null> {
  const { data, error } = await db.from('shopping_feed_snapshots').select('summary')
    .eq('account_id', accountId).eq('snapshot_date', addDaysYmd(date, -1)).maybeSingle();
  if (error) throw error;
  const { error: writeError } = await db.from('shopping_feed_snapshots').upsert({
    account_id: accountId, snapshot_date: date, summary: feed,
  }, { onConflict: 'account_id,snapshot_date' });
  if (writeError) throw writeError;
  const { error: pruneError } = await db.from('shopping_feed_snapshots').delete()
    .lt('snapshot_date', addDaysYmd(date, -89));
  if (pruneError) throw pruneError;
  return data?.summary ?? null;
}
