import { OAuth2Client } from 'google-auth-library';
import { FEATURE_SCOPE, type ExtraFeature } from './features';

/**
 * Consent URL and code exchange for the separate permissions. Uses the same
 * Google OAuth client as the main connect (same client id and secret) with its
 * OWN redirect URI, GOOGLE_EXTRA_OAUTH_REDIRECT_URI, which must be added to the
 * client's authorized redirect URIs in Google Cloud. The main sign-in and the
 * Google Ads connect are not touched.
 *
 * `include_granted_scopes` is deliberately false: the new refresh token carries
 * only this feature's scope (least privilege), and nothing it grants can widen
 * the Google Ads token.
 */
export function extraRedirectUri(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.GOOGLE_EXTRA_OAUTH_REDIRECT_URI?.trim();
  return value || null;
}

export function getExtraOAuthClient(env: Record<string, string | undefined> = process.env): OAuth2Client {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = extraRedirectUri(env);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing Google OAuth env vars. Required: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_EXTRA_OAUTH_REDIRECT_URI');
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export function buildExtraAuthUrl(feature: ExtraFeature, state: string, env: Record<string, string | undefined> = process.env): string {
  return getExtraOAuthClient(env).generateAuthUrl({
    access_type: 'offline',
    // consent: a refresh token is returned every time; select_account: the merchant picks the Google user who owns the data.
    prompt: 'consent select_account',
    scope: [FEATURE_SCOPE[feature]],
    include_granted_scopes: false,
    state,
  });
}

export async function exchangeExtraCode(code: string, env: Record<string, string | undefined> = process.env) {
  const { tokens } = await getExtraOAuthClient(env).getToken(code);
  return tokens;
}

/** Access token for a stored refresh token of one of these grants. */
export async function extraAccessToken(refreshToken: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const client = getExtraOAuthClient(env);
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to refresh access token. The grant may be revoked.');
  return token;
}
