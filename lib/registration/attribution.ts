/**
 * Where a visitor came from. Captured by middleware on the first request that
 * carries marketing parameters, kept in a first-party cookie, copied into the
 * auth user's metadata when the form is submitted (the email link is often
 * opened in a different browser, so the cookie alone would be lost) and
 * written to users.registration_source when the registration completes.
 *
 * Everything here is untrusted input: it comes from a URL anybody can craft,
 * and from user_metadata that the signed-in user can edit. Values are
 * length-capped and stripped of control characters, click ids must match their
 * real shape, and unknown keys are dropped.
 */
export const ATTRIBUTION_COOKIE = 'mz_attr';
export const ATTRIBUTION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export const CLICK_ID_KEYS = ['ttclid', 'gclid'] as const;

export type Attribution = Partial<Record<(typeof UTM_KEYS)[number] | (typeof CLICK_ID_KEYS)[number], string>> & {
  landing_path?: string;
  captured_at?: string;
};

const MAX_VALUE = 200;
const CLICK_ID_PATTERN = /^[A-Za-z0-9._~-]{6,300}$/;

function cleanValue(value: unknown, max = MAX_VALUE) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
  return cleaned || null;
}

export function sanitizeAttribution(input: unknown): Attribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const out: Attribution = {};
  for (const key of UTM_KEYS) {
    const value = cleanValue(source[key]);
    if (value) out[key] = value;
  }
  for (const key of CLICK_ID_KEYS) {
    const value = cleanValue(source[key], 300);
    if (value && CLICK_ID_PATTERN.test(value)) out[key] = value;
  }
  const path = cleanValue(source.landing_path, 200);
  if (path && path.startsWith('/') && !path.startsWith('//')) out.landing_path = path;
  const at = cleanValue(source.captured_at, 40);
  if (at && !Number.isNaN(Date.parse(at))) out.captured_at = at;
  return out;
}

/** True when the object carries a campaign signal (not just a landing path). */
export function hasMarketingSignal(a: Attribution) {
  return Boolean(a.utm_source || a.utm_campaign || a.ttclid || a.gclid);
}

export function extractAttribution(params: URLSearchParams, pathname: string, now: Date = new Date()): Attribution {
  const raw: Record<string, string> = {};
  for (const key of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  const cleaned = sanitizeAttribution({ ...raw, landing_path: pathname, captured_at: now.toISOString() });
  return hasMarketingSignal(cleaned) ? cleaned : {};
}

/**
 * A request with a campaign signal replaces what was stored (the latest click
 * is the one that earned the signup); a request without one never erases it.
 */
export function mergeAttribution(existing: Attribution, incoming: Attribution): Attribution {
  return hasMarketingSignal(incoming) ? incoming : existing;
}

export function parseAttributionCookie(value: string | null | undefined): Attribution {
  if (!value) return {};
  try {
    return sanitizeAttribution(JSON.parse(decodeURIComponent(value)));
  } catch {
    return {};
  }
}

export function serializeAttribution(a: Attribution) {
  return encodeURIComponent(JSON.stringify(sanitizeAttribution(a)));
}

/** Metadata copy wins when it has a campaign signal; otherwise fall back to the cookie. */
export function pickAttribution(fromMetadata: unknown, fromCookie: Attribution): Attribution {
  const meta = sanitizeAttribution(fromMetadata);
  return hasMarketingSignal(meta) ? meta : hasMarketingSignal(fromCookie) ? fromCookie : { ...fromCookie, ...meta };
}
