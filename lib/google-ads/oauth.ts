import { OAuth2Client } from 'google-auth-library';

/**
 * Google OAuth 2.0 helpers for the Google Ads scope.
 * Used during the "Connect Google Ads" flow.
 */

const SCOPES = ['https://www.googleapis.com/auth/adwords'];

export function getOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Missing Google OAuth env vars. Required: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI'
    );
  }

  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

/**
 * Build the Google consent URL for the user to authorize Modaafa.
 * - access_type: offline → returns a refresh_token
 * - prompt: 'consent select_account' → forces the consent screen on repeat
 *   connects (needed to always get a refresh_token) AND offers the account
 *   chooser. Without `select_account` Google silently used whichever Google
 *   account was active in the browser, so a user signed in as owner@… whose
 *   ad accounts live under ads@… landed on `?error=no_accounts` with no way
 *   to pick the right identity, and every retry reproduced it identically.
 * - include_granted_scopes is deliberately NOT set: it would merge the
 *   identity scopes granted at login into this offline grant, so the stored
 *   refresh token would carry more than `adwords`.
 */
export function buildAuthUrl(state: string): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: SCOPES,
    state,
  });
}

/**
 * Exchange the authorization code from the OAuth callback for tokens.
 * Returns { access_token, refresh_token, expiry_date, scope, token_type }.
 */
export async function exchangeCodeForTokens(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token in response. The user may need to revoke previous access at https://myaccount.google.com/permissions and reconnect.'
    );
  }
  return tokens;
}

/**
 * Use a refresh token to obtain a fresh access token.
 * Used on every Google Ads API call.
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Failed to refresh access token. The refresh token may be revoked.');
  }
  return token;
}

export async function revokeRefreshToken(refreshToken: string) {
  const client = getOAuth2Client();
  await client.revokeToken(refreshToken);
}
