/**
 * TikTok Pixel — the pure half: configuration, event ids, the registration
 * window, the once-per-browser guard and the base snippet. Everything that
 * needs React or the request lives in `tiktok-pixel.tsx`, so this file can be
 * unit-tested without a Next runtime.
 *
 * Nothing here ever sends personal data. Events carry no parameters, no
 * `ttq.identify()` call is made, and the only user-derived value that reaches
 * TikTok is the opaque auth user id inside the dedup `event_id`.
 */

/** Read at request time on the server (never `NEXT_PUBLIC_`, so never inlined at build). */
export const TIKTOK_PIXEL_ENV = 'TIKTOK_PIXEL_ID';

/** The two conversion events this app reports; PageView is sent separately via `ttq.page()`. */
export type TikTokConversionEvent = 'CompleteRegistration' | 'Subscribe';

/** A signup only counts as a registration while the account is this young. */
export const REGISTRATION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Supabase stamps `created_at` on its own clock, so a brand-new account can
 * look a few seconds "in the future" to this server. Tolerate that, but not a
 * wildly future timestamp.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * TikTok pixel codes are 20 uppercase alphanumerics. The value is interpolated
 * into an inline script, so anything outside this shape is treated as "off"
 * rather than escaped and shipped — a typo in the env var must not be able to
 * break out of the string literal.
 */
const PIXEL_ID_PATTERN = /^[A-Za-z0-9]{10,32}$/;

/** Returns the validated pixel code, or null when the pixel must stay fully off. */
export function resolveTikTokPixelId(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  return value && PIXEL_ID_PATTERN.test(value) ? value : null;
}

/** True while `createdAt` (an ISO timestamp) is less than 30 minutes old. */
export function isRecentRegistration(
  createdAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age > -CLOCK_SKEW_MS && age < REGISTRATION_WINDOW_MS;
}

const EVENT_ID_PREFIX: Record<TikTokConversionEvent, string> = {
  CompleteRegistration: 'reg',
  Subscribe: 'sub',
};

/**
 * Stable per user per event, so a reload, a second device or a later server-side
 * (Events API) report all collapse into one conversion on TikTok's side.
 */
export function buildTikTokEventId(event: TikTokConversionEvent, userId: string | null | undefined): string | null {
  const id = userId?.trim();
  return id ? `${EVENT_ID_PREFIX[event]}_${id}` : null;
}

type GuardStorage = Pick<Storage, 'getItem' | 'setItem'>;

const GUARD_KEY_PREFIX = 'modaafa:tiktok:';

/**
 * Once-per-browser guard. Returns true when the event should be sent now and
 * marks it as sent. When storage is unavailable (private mode, blocked site
 * data) it returns true: a repeat is absorbed by TikTok's `event_id` dedup,
 * whereas a lost conversion cannot be recovered.
 */
export function claimTikTokEvent(storage: GuardStorage | null | undefined, eventId: string): boolean {
  if (!storage) return true;
  const key = `${GUARD_KEY_PREFIX}${eventId}`;
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, '1');
  } catch {
    // Storage threw — fall through and send.
  }
  return true;
}

/**
 * The official TikTok base code (the `ttq` queue stub plus the loader for
 * analytics.tiktok.com/i18n/pixel/events.js), minus its trailing `ttq.page()`.
 * Whether a page reports a PageView is decided by the page, not by the snippet:
 * onboarding and the dashboard must load the pixel without sending one.
 */
export function tiktokBaseSnippet(pixelId: string): string {
  return (
    '!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];' +
    'ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],' +
    'ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};' +
    'for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);' +
    'ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},' +
    'ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;' +
    'ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};' +
    'n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;' +
    'e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};' +
    `ttq.load(${JSON.stringify(pixelId)});}(window,document,"ttq");`
  );
}

export type TikTokPixelPlan = {
  snippet: string;
  pageView: boolean;
  /** Present only when a conversion is due AND a user id exists to key it on. */
  conversion: { event: TikTokConversionEvent; eventId: string } | null;
};

/**
 * Decides what a page should render. `null` means the pixel is off entirely:
 * no script, no events.
 */
export function planTikTokPixel(
  rawPixelId: string | null | undefined,
  options: { pageView?: boolean; conversion?: { event: TikTokConversionEvent; userId: string } },
): TikTokPixelPlan | null {
  const pixelId = resolveTikTokPixelId(rawPixelId);
  if (!pixelId) return null;

  const eventId = options.conversion
    ? buildTikTokEventId(options.conversion.event, options.conversion.userId)
    : null;

  return {
    snippet: tiktokBaseSnippet(pixelId),
    pageView: Boolean(options.pageView),
    conversion: options.conversion && eventId ? { event: options.conversion.event, eventId } : null,
  };
}
