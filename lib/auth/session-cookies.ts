import type { NextResponse } from 'next/server';
import { GOOGLE_ADS_OAUTH_STATE_COOKIE } from '@/lib/auth/google-ads-oauth-state';
import { GOOGLE_LOGIN_NEXT_COOKIE, GOOGLE_LOGIN_STATE_COOKIE } from '@/lib/auth/google-login';
import { clearPendingSessionCookies } from '@/lib/auth/google-ads-pending-cookie';

/**
 * Selected-account cookie name.
 *
 * Duplicated from `lib/accounts/selection` on purpose: importing that module
 * here would pull the Supabase client into the middleware bundle.
 */
export const SELECTED_ADS_ACCOUNT_COOKIE_NAME = 'modaafa_selected_customer_id';

/**
 * Every non-Supabase cookie this app issues.
 *
 * Sign-out used to clear only the Supabase session, leaving `gads_oauth_state`
 * (1h), `modaafa_selected_customer_id` (90d) and the login state behind. On a
 * shared browser that meant the next user inherited the previous user's
 * pending OAuth state and default account selection.
 */
export function clearModaafaCookies<T extends NextResponse>(res: T): T {
  res.cookies.delete(GOOGLE_ADS_OAUTH_STATE_COOKIE);
  res.cookies.delete(GOOGLE_LOGIN_STATE_COOKIE);
  res.cookies.delete(GOOGLE_LOGIN_NEXT_COOKIE);
  res.cookies.delete(SELECTED_ADS_ACCOUNT_COOKIE_NAME);
  clearPendingSessionCookies(res);
  return res;
}
