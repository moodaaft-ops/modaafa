/**
 * The demo-video slot on /welcome.
 *
 * Nothing is shown until a real video exists: an empty frame on a first-login
 * screen reads as broken. Set NEXT_PUBLIC_WELCOME_VIDEO_EMBED_URL to a
 * youtube-nocookie.com embed link (the only frame source the CSP allows, see
 * lib/security/csp.ts) and the slot appears.
 */
const ALLOWED_PREFIX = 'https://www.youtube-nocookie.com/embed/';

export type WelcomeVideo = { embedUrl: string; title: string };

export function getWelcomeVideo(
  env: Record<string, string | undefined> = process.env
): WelcomeVideo | null {
  const url = env.NEXT_PUBLIC_WELCOME_VIDEO_EMBED_URL?.trim();
  if (!url || !url.startsWith(ALLOWED_PREFIX)) return null;
  return { embedUrl: url, title: 'شرح ربط حساب Google Ads في مُضاعِف' };
}

/** Same rule as /onboarding/connect: Google warns about unverified apps. */
export function isGoogleAppVerified(env: Record<string, string | undefined> = process.env) {
  return env.GOOGLE_OAUTH_APP_VERIFIED === 'true';
}
