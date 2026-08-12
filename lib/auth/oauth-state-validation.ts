import { hasGoogleAdsOAuthState } from '@/lib/auth/google-ads-oauth-state';
import type { ConsumeOAuthStateResult } from '@/lib/auth/oauth-state-store';

export type OAuthStateValidation =
  | { accepted: true; usedCookieFallback: boolean }
  | { accepted: false; error: 'state_user_mismatch' | 'state_mismatch' };

/**
 * Accept a cookie-only state exclusively when durable storage is unavailable.
 * A missing or wrong-user server record must never be rescued by a browser
 * cookie, otherwise a shared browser can attach one user's Google token to
 * another user's workspace.
 */
export function validateGoogleAdsOAuthState(params: {
  serverResult: ConsumeOAuthStateResult;
  cookieValue?: string;
  returnedState: string;
}): OAuthStateValidation {
  if (params.serverResult === 'ok') {
    return { accepted: true, usedCookieFallback: false };
  }

  if (
    params.serverResult === 'unavailable' &&
    hasGoogleAdsOAuthState(params.cookieValue, params.returnedState)
  ) {
    return { accepted: true, usedCookieFallback: true };
  }

  return {
    accepted: false,
    error: params.serverResult === 'user_mismatch' ? 'state_user_mismatch' : 'state_mismatch',
  };
}
