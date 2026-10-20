import { compareRevenue, type RevenueComparison } from './orders';

/**
 * Real store revenue against what Google reports, for one Google Ads account
 * and one window. Orders come from store_orders (STORE_SYNC_ENABLED). Cancelled
 * and refunded orders are left out. Aggregate on purpose: an order with no
 * click signal still counts toward the store total.
 */
type Db = any;

export type StoreRevenueBlock = {
  window_days: number;
  store_revenue: number;
  store_orders: number;
  attributed_revenue: number;
  attributed_orders: number;
  google_reported_value: number;
  google_to_store_ratio: number | null;
  verdict: RevenueComparison['verdict'];
};

export async function loadStoreRevenue(
  db: Db,
  accountId: string,
  fromIso: string,
  toIso: string,
  googleReportedValue: number
): Promise<RevenueComparison | null> {
  const { data: conns, error: connError } = await db
    .from('store_connections')
    .select('id')
    .eq('account_id', accountId)
    .eq('status', 'active');
  if (connError) throw connError;
  const ids = ((conns ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return null;
  const { data, error } = await db
    .from('store_orders')
    .select('total, cancelled, lead_click_id')
    .in('connection_id', ids)
    .gte('placed_at', fromIso)
    .lt('placed_at', toIso)
    .limit(5000);
  if (error) throw error;
  const orders = ((data ?? []) as { total: number | string; cancelled: boolean; lead_click_id: string | null }[]).map((o) => ({
    total: Number(o.total),
    cancelled: Boolean(o.cancelled),
    attributed: Boolean(o.lead_click_id),
  }));
  return compareRevenue({ orders, googleReportedValue });
}

export function storeRevenueBlock(cmp: RevenueComparison | null, windowDays: number): StoreRevenueBlock | null {
  if (!cmp || cmp.verdict === 'insufficient_data') return null;
  return {
    window_days: windowDays,
    store_revenue: cmp.store_revenue,
    store_orders: cmp.store_orders,
    attributed_revenue: cmp.attributed_revenue,
    attributed_orders: cmp.attributed_orders,
    google_reported_value: cmp.google_reported_value,
    google_to_store_ratio: cmp.google_to_store_ratio,
    verdict: cmp.verdict,
  };
}

export async function readGoogleConversionValue(customer: { query(gaql: string): Promise<any[]> }, days = 30): Promise<number> {
  const during = days <= 7 ? 'LAST_7_DAYS' : days <= 14 ? 'LAST_14_DAYS' : 'LAST_30_DAYS';
  const rows = await customer.query(`SELECT metrics.conversions_value FROM customer WHERE segments.date DURING ${during}`);
  let total = 0;
  for (const row of rows ?? []) {
    const v = Number(row?.metrics?.conversions_value ?? row?.['metrics.conversions_value'] ?? 0);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/** One merchant-facing Arabic line for the monthly money report. Numbers come from the block only. */
export function storeRevenueLine(block: StoreRevenueBlock, currency: string): string {
  const fmt = (n: number) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)} ${currency === 'SAR' ? 'ريال' : currency}`;
  const base = `متجرك سجل ${block.store_orders} طلب بقيمة ${fmt(block.store_revenue)} آخر ${block.window_days} يوم، وقوقل سجلت تحويلات بقيمة ${fmt(block.google_reported_value)}.`;
  if (block.verdict === 'google_overstates') return `${base} قوقل تسجل أكثر من مبيعات المتجر الفعلية، فلا نعتمد على رقمها وحده.`;
  if (block.verdict === 'google_understates') return `${base} قوقل تسجل أقل من مبيعات المتجر، يعني جزء من المبيعات ما ينسب للإعلانات في التتبع.`;
  return `${base} الرقمان متقاربان.`;
}
