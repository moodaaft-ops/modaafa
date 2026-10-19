/**
 * Order normalisation, click matching and the revenue comparison.
 * Payload shapes for Salla and Zid are NOT verified against live deliveries,
 * so every field is read defensively and an unreadable order is dropped, not guessed.
 */

export type StorePlatform = 'salla' | 'zid' | 'shopify';

export type NormalizedOrder = {
  platform: StorePlatform;
  external_id: string;
  event: string;
  status: string | null;
  total: number;
  currency: string;
  placed_at: string | null;
  gclid: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  ref_code: string | null;
  cancelled: boolean;
};

const CANCEL_WORDS = ['cancel', 'refund', 'returned', 'ملغ', 'مسترج'];

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  const o = obj(v);
  if (o) return num(o.amount ?? o.value ?? o.total);
  return null;
}
function iso(v: unknown): string | null {
  const o = obj(v);
  const raw = o ? (o.date ?? null) : v;
  const s = str(raw);
  if (!s) return null;
  const t = Date.parse(s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const GCLID = /^[A-Za-z0-9_-]{20,200}$/;

function extractTracking(o: Record<string, unknown>) {
  const sources = [o, obj(o.utm), obj(o.tracking), obj(o.marketing)].filter(Boolean) as Record<string, unknown>[];
  const pick = (...keys: string[]) => {
    for (const s of sources) for (const k of keys) { const v = str(s[k]); if (v) return v; }
    return null;
  };
  const gclidRaw = pick('gclid', 'utm_gclid');
  const note = str(o.customer_note) ?? str(o.notes) ?? str(o.note) ?? '';
  const ref = /\bM-[2-9A-HJKMNP-Z]{4,6}\b/.exec(note)?.[0] ?? pick('ref_code', 'ref');
  return {
    gclid: gclidRaw && GCLID.test(gclidRaw) ? gclidRaw : null,
    utm_source: pick('utm_source'),
    utm_campaign: pick('utm_campaign'),
    ref_code: ref && /^M-[2-9A-HJKMNP-Z]{4,6}$/.test(ref) ? ref : null,
  };
}

export function normalizeOrderEvent(platform: StorePlatform, payload: unknown): NormalizedOrder | null {
  const root = obj(payload);
  if (!root) return null;
  const event = str(root.event) ?? '';
  const data = obj(root.data) ?? obj(root.order) ?? root;
  const external = str(data.id) ?? str(data.order_id) ?? str(data.reference_id);
  if (!external) return null;
  const total = num(data.total) ?? num(data.order_total) ?? num(data.amounts && obj(data.amounts)?.total);
  if (total === null || total < 0) return null;
  const statusObj = obj(data.status);
  const status = str(statusObj?.slug) ?? str(statusObj?.name) ?? str(data.status) ?? str(data.order_status);
  const currency = (str(data.currency) ?? str(obj(data.total)?.currency) ?? 'SAR').toUpperCase();
  const lowered = `${event} ${status ?? ''}`.toLowerCase();
  return {
    platform,
    external_id: external,
    event,
    status,
    total,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'SAR',
    placed_at: iso(data.date) ?? iso(data.created_at) ?? iso(root.created_at),
    cancelled: CANCEL_WORDS.some((w) => lowered.includes(w)),
    ...extractTracking(data),
  };
}

export type ClickRef = { id: string; gclid: string | null; ref_code: string };
export type MatchMethod = 'gclid' | 'ref_code' | 'none';

/** Exact matches only. An order with no signal stays in the aggregate. */
export function matchOrderToClick(
  order: Pick<NormalizedOrder, 'gclid' | 'ref_code'>,
  clicks: ClickRef[]
): { method: MatchMethod; click_id: string | null } {
  if (order.gclid) {
    const hit = clicks.find((c) => c.gclid === order.gclid);
    if (hit) return { method: 'gclid', click_id: hit.id };
  }
  if (order.ref_code) {
    const hit = clicks.find((c) => c.ref_code === order.ref_code);
    if (hit) return { method: 'ref_code', click_id: hit.id };
  }
  return { method: 'none', click_id: null };
}

export type RevenueComparison = {
  store_revenue: number;
  store_orders: number;
  attributed_revenue: number;
  attributed_orders: number;
  google_reported_value: number;
  /** google / store; null when the store has no revenue. >1 means Google claims more than the store saw. */
  google_to_store_ratio: number | null;
  verdict: 'insufficient_data' | 'consistent' | 'google_overstates' | 'google_understates';
};

export function compareRevenue(args: {
  orders: { total: number; cancelled: boolean; attributed: boolean }[];
  googleReportedValue: number;
  minOrders?: number;
}): RevenueComparison {
  const live = args.orders.filter((o) => !o.cancelled);
  const store = live.reduce((s, o) => s + o.total, 0);
  const attr = live.filter((o) => o.attributed);
  const attributed = attr.reduce((s, o) => s + o.total, 0);
  const ratio = store > 0 ? args.googleReportedValue / store : null;
  let verdict: RevenueComparison['verdict'] = 'insufficient_data';
  if (ratio !== null && live.length >= (args.minOrders ?? 10)) {
    verdict = ratio > 1.25 ? 'google_overstates' : ratio < 0.6 ? 'google_understates' : 'consistent';
  }
  return {
    store_revenue: Math.round(store * 100) / 100,
    store_orders: live.length,
    attributed_revenue: Math.round(attributed * 100) / 100,
    attributed_orders: attr.length,
    google_reported_value: args.googleReportedValue,
    google_to_store_ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    verdict,
  };
}

/**
 * Shopify order webhook (topics orders/create, orders/updated, orders/cancelled,
 * orders/paid). The body IS the order. Documented fields: id, total_price
 * (string), currency, created_at, cancelled_at, financial_status, landing_site
 * (path with the query string of the first visit, so gclid and utm_* arrive
 * there), note_attributes. Tracking is read from landing_site and note.
 */
export function normalizeShopifyOrder(topic: string, payload: unknown): NormalizedOrder | null {
  const o = obj(payload);
  if (!o) return null;
  const id = str(o.id);
  const total = num(o.total_price);
  if (!id || total === null || total < 0) return null;
  const params = new URLSearchParams((str(o.landing_site) ?? '').split('?')[1] ?? '');
  const gclid = params.get('gclid');
  const attrs = Array.isArray(o.note_attributes) ? (o.note_attributes as unknown[]) : [];
  const attr = (name: string) => {
    for (const a of attrs) {
      const r = obj(a);
      if (r && r.name === name) return str(r.value);
    }
    return null;
  };
  const note = `${str(o.note) ?? ''} ${attr('ref_code') ?? ''}`;
  const ref = /\bM-[2-9A-HJKMNP-Z]{4,6}\b/.exec(note)?.[0] ?? null;
  const status = str(o.financial_status);
  const currency = (str(o.currency) ?? 'SAR').toUpperCase();
  const lowered = `${topic} ${status ?? ''}`.toLowerCase();
  return {
    platform: 'shopify',
    external_id: id,
    event: topic,
    status,
    total,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'SAR',
    placed_at: iso(o.created_at),
    cancelled: Boolean(str(o.cancelled_at)) || lowered.includes('cancel') || lowered.includes('refunded'),
    gclid: gclid && GCLID.test(gclid) ? gclid : null,
    utm_source: params.get('utm_source'),
    utm_campaign: params.get('utm_campaign'),
    ref_code: ref,
  };
}
