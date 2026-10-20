/**
 * GA4 landing page / engagement summary (Analytics Data API v1beta runReport).
 * Read only, scope analytics.readonly via the separate GA4 grant. Wire format
 * taken from the public API reference; not exercised live from this build.
 */
export type Ga4LandingRow = { landing_page: string; sessions: number; engaged_sessions: number; engagement_rate: number; avg_session_seconds: number; key_events: number };
export type Ga4Summary = { property_id: string; days: number; rows: Ga4LandingRow[]; total_sessions: number; weak_pages: Ga4LandingRow[] };

export function ga4PropertyId(raw: string): string | null {
  const m = /^(?:properties\/)?(\d{4,15})$/.exec(raw.trim());
  return m ? m[1] : null;
}

export function buildGa4Request(days: number, limit = 25) {
  const d = Math.min(90, Math.max(1, Math.round(days)));
  return {
    dateRanges: [{ startDate: `${d}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'landingPagePlusQueryString' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'engagementRate' }, { name: 'averageSessionDuration' }, { name: 'keyEvents' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: String(limit),
  };
}

export function parseGa4Report(propertyId: string, days: number, json: unknown): Ga4Summary {
  const rows = (((json as { rows?: unknown[] })?.rows ?? []) as { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[])
    .map((r): Ga4LandingRow | null => {
      const page = r.dimensionValues?.[0]?.value;
      const m = (r.metricValues ?? []).map((v) => Number(v.value));
      if (!page || m.length < 5 || m.some((n) => !Number.isFinite(n))) return null;
      return { landing_page: page.slice(0, 200), sessions: m[0], engaged_sessions: m[1], engagement_rate: m[2], avg_session_seconds: m[3], key_events: m[4] };
    })
    .filter((r): r is Ga4LandingRow => r !== null);
  const total = rows.reduce((s, r) => s + r.sessions, 0);
  const weak = rows.filter((r) => r.sessions >= 30 && r.engagement_rate < 0.3).slice(0, 5);
  return { property_id: propertyId, days, rows, total_sessions: total, weak_pages: weak };
}

export async function readGa4Summary(args: { accessToken: string; propertyId: string; days?: number; fetchImpl?: typeof fetch }): Promise<Ga4Summary> {
  const id = ga4PropertyId(args.propertyId);
  if (!id) throw new Error('invalid_ga4_property');
  const days = args.days ?? 30;
  const res = await (args.fetchImpl ?? fetch)(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGa4Request(days)),
  });
  if (!res.ok) throw new Error(`ga4_read_${res.status}`);
  return parseGa4Report(id, days, await res.json());
}
