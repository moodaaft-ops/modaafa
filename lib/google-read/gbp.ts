/**
 * Google Business Profile read: rating, review count, hours, profile state.
 * Needs business.manage AND an approved GBP API project (Google must approve
 * the project before any call works; until then calls return 403/429).
 * Endpoints (public reference, not exercised live):
 *  - mybusinessbusinessinformation.googleapis.com/v1/locations/{id}?readMask=title,regularHours,openInfo,metadata
 *  - mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews?pageSize=1  (averageRating, totalReviewCount)
 */
export type GbpDay = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';
export type GbpPeriod = { day: GbpDay; open: string; close: string };
export type GbpProfile = {
  title: string | null;
  rating: number | null;
  review_count: number | null;
  open_status: string | null;
  periods: GbpPeriod[];
  profile_state: 'open' | 'closed' | 'unknown';
};

const DAYS = new Set(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);
const t = (x: unknown): string | null => {
  const o = x as { hours?: number; minutes?: number } | undefined;
  if (!o) return null;
  const h = o.hours ?? 0; const m = o.minutes ?? 0;
  return Number.isFinite(h) && Number.isFinite(m) ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
};

export function parseGbpLocation(loc: unknown, reviews: unknown): GbpProfile {
  const l = (loc ?? {}) as { title?: string; regularHours?: { periods?: { openDay?: string; openTime?: unknown; closeTime?: unknown }[] }; openInfo?: { status?: string } };
  const periods: GbpPeriod[] = [];
  for (const p of l.regularHours?.periods ?? []) {
    const open = t(p.openTime); const close = t(p.closeTime) ?? '24:00';
    if (p.openDay && DAYS.has(p.openDay) && open) periods.push({ day: p.openDay as GbpDay, open, close });
  }
  const r = (reviews ?? {}) as { averageRating?: number; totalReviewCount?: number };
  const status = l.openInfo?.status ?? null;
  return {
    title: l.title ?? null,
    rating: typeof r.averageRating === 'number' ? r.averageRating : null,
    review_count: typeof r.totalReviewCount === 'number' ? r.totalReviewCount : null,
    open_status: status,
    periods,
    profile_state: status === 'OPEN' ? 'open' : status ? 'closed' : 'unknown',
  };
}

/**
 * Evidence only. Describes whether the profile's published hours cover the
 * hours the merchant said they answer. Never changes a decision.
 */
export function gbpHoursEvidence(periods: GbpPeriod[], answeringHours: { open: number; close: number } | null): { text: string; agrees: boolean | null } | null {
  if (!periods.length) return null;
  const toH = (s: string) => Number(s.slice(0, 2)) + Number(s.slice(3, 5)) / 60;
  const earliest = Math.min(...periods.map((p) => toH(p.open)));
  const latest = Math.max(...periods.map((p) => toH(p.close)));
  const text = `ملف نشاطك على خرائط جوجل يعرض دوام من ${Math.floor(earliest)}:00 إلى ${Math.floor(latest)}:00`;
  if (!answeringHours) return { text, agrees: null };
  const agrees = Math.abs(earliest - answeringHours.open) <= 1 && Math.abs(latest - answeringHours.close) <= 1;
  return { text: agrees ? text : `${text} وهذا يختلف عن ساعات الرد التي ذكرتها`, agrees };
}

export async function readGbpProfile(args: { accessToken: string; locationId: string; accountId?: string; fetchImpl?: typeof fetch }): Promise<GbpProfile> {
  if (!/^\d{5,25}$/.test(args.locationId)) throw new Error('invalid_gbp_location');
  const f = args.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${args.accessToken}` };
  const locRes = await f(`https://mybusinessbusinessinformation.googleapis.com/v1/locations/${args.locationId}?readMask=title,regularHours,openInfo`, { headers });
  if (!locRes.ok) throw new Error(`gbp_read_${locRes.status}`);
  let reviews: unknown = null;
  if (args.accountId && /^\d{5,25}$/.test(args.accountId)) {
    const rv = await f(`https://mybusiness.googleapis.com/v4/accounts/${args.accountId}/locations/${args.locationId}/reviews?pageSize=1`, { headers });
    if (rv.ok) reviews = await rv.json();
  }
  return parseGbpLocation(await locRes.json(), reviews);
}

/**
 * Finds the one location of the signed-in Google user, or null when there are
 * none or several (we never guess which place is the merchant's). Needs the
 * approved GBP API project; any failure returns null.
 *  accounts:  mybusinessaccountmanagement.googleapis.com/v1/accounts
 *  locations: mybusinessbusinessinformation.googleapis.com/v1/accounts/{a}/locations?readMask=name
 */
export async function discoverGbpLocation(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ accountId: string; locationId: string } | null> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  try {
    const a = await fetchImpl('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=5', { headers });
    if (!a.ok) return null;
    const accounts = ((await a.json()) as { accounts?: { name?: string }[] }).accounts ?? [];
    if (accounts.length !== 1) return null;
    const accountId = /^accounts\/(\d{5,25})$/.exec(accounts[0].name ?? '')?.[1];
    if (!accountId) return null;
    const l = await fetchImpl(`https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations?readMask=name&pageSize=3`, { headers });
    if (!l.ok) return null;
    const locations = ((await l.json()) as { locations?: { name?: string }[] }).locations ?? [];
    if (locations.length !== 1) return null;
    const locationId = /^locations\/(\d{5,25})$/.exec(locations[0].name ?? '')?.[1];
    return locationId ? { accountId, locationId } : null;
  } catch {
    return null;
  }
}

/** Answering windows from the setup answer, as one span [open, close). */
export function answeringSpan(windows: Array<[number, number]> | undefined): { open: number; close: number } | null {
  if (!windows || windows.length === 0) return null;
  return { open: Math.min(...windows.map((w) => w[0])), close: Math.max(...windows.map((w) => w[1])) };
}
