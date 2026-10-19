import type { SupabaseClient } from '@supabase/supabase-js';
import { matchOrderToClick, type NormalizedOrder, type StorePlatform } from './orders';

/** Persist one normalised order for a connected store and match it to a click. Idempotent on (connection, external id). */
export async function recordOrder(
  db: SupabaseClient,
  platform: StorePlatform,
  externalStoreId: string,
  order: NormalizedOrder
): Promise<{ stored: boolean; reason?: string; method?: string }> {
  const { data: conn, error: connError } = await db
    .from('store_connections')
    .select('id, account_id, status')
    .eq('platform', platform)
    .eq('external_store_id', externalStoreId)
    .maybeSingle();
  if (connError) throw connError;
  if (!conn || conn.status === 'revoked') return { stored: false, reason: 'unknown_store' };

  let clickId: string | null = null;
  let method = 'none';
  if (conn.account_id && (order.gclid || order.ref_code)) {
    const filters = [order.gclid ? `gclid.eq.${order.gclid}` : null, order.ref_code ? `ref_code.eq.${order.ref_code}` : null].filter(Boolean);
    const { data: clicks, error } = await db
      .from('lead_clicks')
      .select('id, gclid, ref_code')
      .eq('account_id', conn.account_id)
      .or(filters.join(','))
      .limit(5);
    if (error) throw error;
    const hit = matchOrderToClick(order, (clicks ?? []) as { id: string; gclid: string | null; ref_code: string }[]);
    clickId = hit.click_id;
    method = hit.method;
  }

  const { error } = await db.from('store_orders').upsert(
    {
      connection_id: conn.id, platform, external_id: order.external_id, status: order.status,
      total: order.total, currency: order.currency, cancelled: order.cancelled, placed_at: order.placed_at,
      gclid: order.gclid, utm_source: order.utm_source, utm_campaign: order.utm_campaign, ref_code: order.ref_code,
      lead_click_id: clickId, match_method: method, last_event: order.event, updated_at: new Date().toISOString(),
    },
    { onConflict: 'connection_id,external_id' }
  );
  if (error) throw error;
  return { stored: true, method };
}
