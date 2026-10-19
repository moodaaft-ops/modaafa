/**
 * Marketing parameters of the click that ended on the merchant's WhatsApp
 * button. Everything here is untrusted input from a URL anyone can craft:
 * click ids must match their real shape, utm values are capped and stripped of
 * control characters, unknown keys are dropped.
 */
export const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'] as const;
export const LEAD_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export type LeadClickParams = Partial<
  Record<(typeof CLICK_ID_KEYS)[number] | (typeof LEAD_UTM_KEYS)[number], string>
> & { landing_path?: string };

const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{10,255}$/;
const MAX_UTM = 100;

function cleanUtm(value: string | null) {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').trim().slice(0, MAX_UTM);
  return cleaned || null;
}

function cleanClickId(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return CLICK_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function cleanPath(value: string | null | undefined) {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const path = value.replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').trim().split(/[?#]/)[0].slice(0, 200);
  return path.startsWith('/') && !path.startsWith('//') ? path : null;
}

function refererParams(referer: string | null | undefined) {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Query first (the snippet on the merchant's page appends the parameters to the
 * link), the Referer's own query as a fallback for browsers that send the full
 * URL. Browsers default to sending only the origin, so the referrer rarely
 * carries a click id: the snippet is the reliable path.
 */
export function parseLeadClickParams(
  searchParams: URLSearchParams,
  referer?: string | null
): LeadClickParams {
  const fromReferer = refererParams(referer);
  const read = (key: string) => searchParams.get(key) ?? fromReferer?.searchParams.get(key) ?? null;

  const out: LeadClickParams = {};
  for (const key of CLICK_ID_KEYS) {
    const value = cleanClickId(read(key));
    if (value) out[key] = value;
  }
  for (const key of LEAD_UTM_KEYS) {
    const value = cleanUtm(read(key));
    if (value) out[key] = value;
  }
  // `lp` is the page the visitor was on, sent by the snippet. Path only, never a query.
  const path = cleanPath(searchParams.get('lp')) ?? cleanPath(fromReferer?.pathname);
  if (path) out.landing_path = path;
  return out;
}

export function hasClickId(params: Pick<LeadClickParams, 'gclid' | 'gbraid' | 'wbraid'>) {
  return Boolean(params.gclid || params.gbraid || params.wbraid);
}
