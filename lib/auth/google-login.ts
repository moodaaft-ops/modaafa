import { OAuth2Client } from 'google-auth-library';
import { safeLocalPath } from '@/lib/security/redirect';

export const GOOGLE_LOGIN_SCOPES = ['openid', 'email', 'profile'];
export const GOOGLE_LOGIN_STATE_COOKIE = 'modaafa_google_login_state';
export const GOOGLE_LOGIN_NEXT_COOKIE = 'modaafa_google_login_next';

export function getGoogleLoginClient(origin: string) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Google OAuth env vars for login.');
  }

  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: getGoogleLoginRedirectUri(origin),
  });
}

export function getGoogleLoginRedirectUri(origin: string) {
  const explicit = normalizedEnv(process.env.GOOGLE_LOGIN_REDIRECT_URI);
  if (explicit) return explicit;

  // Prefer the canonical production URL so the login redirect URI always
  // matches what is registered in Google Cloud, even when the app is reached
  // through a non-canonical origin (e.g. *.vercel.app preview/deploy URLs).
  // This is the root cause of redirect_uri_mismatch after signing out/in.
  const appUrl = normalizedEnv(process.env.NEXT_PUBLIC_APP_URL);
  const base = (appUrl ?? origin).replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

/**
 * Local-path guard for the post-login `next` parameter.
 *
 * Delegates to `safeLocalPath`, which additionally rejects backslashes.
 * A bare `startsWith('/') && !startsWith('//')` check is NOT enough:
 * browsers normalise `\` to `/` in the relative-slash state, so
 * `/\evil.com` survives that check and `new URL(next, origin)` resolves
 * it to `https://evil.com/` — an open redirect fired at the single most
 * credible moment in the whole product, right after a Google login.
 */
export function getSafeNextPath(next: string | null) {
  return safeLocalPath(next, '/dashboard');
}

function normalizedEnv(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized || normalized === '""' || normalized === "''") return null;
  // A trailing slash on GOOGLE_LOGIN_REDIRECT_URI is a permanent
  // redirect_uri_mismatch, so normalise it here rather than trusting the
  // operator to have typed it exactly.
  return normalized.replace(/\/+$/, '');
}
