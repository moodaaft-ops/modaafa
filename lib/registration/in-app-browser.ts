import { CLICK_ID_KEYS, UTM_KEYS, type Attribution } from './attribution';

/**
 * In-app browsers (TikTok, Instagram, Snapchat, Facebook) and how to leave them.
 *
 * Most of our paid traffic is a TikTok ad, so the visitor reads the landing
 * page inside TikTok's own browser. That browser has an empty cookie jar: the
 * visitor's Google account is signed in on Safari or Chrome, not there. Google
 * sign-in still works inside TikTok (tested on a real phone, 13 Oct 2026), but
 * it asks for the Google email and password from scratch, which is where people
 * give up. Reopening the page in the phone's real browser turns it into one tap.
 *
 * Email sign-up works fine inside the app, so this is an offer next to the
 * form, never a wall in front of it.
 */
export type InAppApp = 'tiktok' | 'instagram' | 'facebook' | 'snapchat';
export type InAppOs = 'ios' | 'android' | 'other';
export type InAppBrowser = { app: InAppApp; os: InAppOs };

// Order matters: Instagram's Android user agent can carry Facebook tokens.
const RULES: ReadonlyArray<readonly [InAppApp, RegExp]> = [
  ['tiktok', /musical_ly|BytedanceWebview|ByteLocale|\btrill_\d|\bTikTok\b/i],
  ['instagram', /\bInstagram\b/i],
  ['facebook', /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b/],
  ['snapchat', /\bSnapchat\b/i],
];

export const IN_APP_LABEL_AR: Record<InAppApp, string> = {
  tiktok: 'تيك توك',
  instagram: 'انستقرام',
  facebook: 'فيسبوك',
  snapchat: 'سناب شات',
};

export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowser | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 1000);
  const hit = RULES.find(([, pattern]) => pattern.test(ua));
  if (!hit) return null;
  const os: InAppOs = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'other';
  return { app: hit[0], os };
}

/**
 * The page to reopen in the real browser, carrying the campaign parameters in
 * the URL. The attribution cookie lives in the in-app browser and does not
 * travel; with the parameters in the URL, middleware captures them again in
 * the new browser, so the signup still counts for the ad that earned it.
 */
export function buildReopenUrl(appUrl: string, path: string, attribution: Attribution): URL {
  const url = new URL(path, appUrl);
  for (const key of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
    const value = attribution[key];
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

/**
 * A link that asks the phone to open `target` outside the app, or null when
 * there is no such mechanism and the visitor has to use the app's own menu.
 *
 * Android: an intent URL for Chrome, falling back to the plain https link if
 * Chrome is missing. iOS: the x-safari-https scheme (iOS 17 and later). Some
 * apps block custom schemes, so the UI always shows the manual route as well.
 */
export function buildOpenInBrowserHref(target: URL, os: InAppOs): string | null {
  if (target.protocol !== 'https:') return null;
  const rest = `${target.host}${target.pathname}${target.search}`;
  if (os === 'android') {
    return `intent://${rest}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target.toString())};end`;
  }
  if (os === 'ios') return `x-safari-https://${rest}`;
  return null;
}
