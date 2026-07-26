import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Server-side OAuth state storage (Supabase table: oauth_states).
 *
 * Why: cookie-only CSRF state proved brittle in production —
 * 10-minute cookie expiry vs. slow/stuck Google consent screens,
 * multi-tab flows, and host/profile mismatches all caused
 * `state_mismatch`. Storing state server-side, tied to the user id,
 * single-use, with a 60-minute TTL removes that fragility while
 * keeping CSRF protection intact (state must exist, be unused,
 * unexpired, and belong to the same logged-in user).
 *
 * The httpOnly state cookie is kept as a secondary defense and as a
 * fallback if the table is unavailable (e.g. migration not applied yet).
 */

const STATE_TTL_MINUTES = 60;

export type OAuthStatePurpose = 'google_ads_connect';

export type ConsumeOAuthStateResult =
  | 'ok'
  | 'not_found'
  | 'user_mismatch'
  | 'unavailable';

export function hashOAuthState(state: string) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/**
 * Persist a freshly generated state for the given user.
 * Returns true when stored; false when storage is unavailable
 * (callers should still set the fallback cookie either way).
 */
export async function persistOAuthState(params: {
  userId: string;
  state: string;
  purpose: OAuthStatePurpose;
  returnTo?: string | null;
}): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString();

    const { error } = await admin.from('oauth_states').insert({
      state_hash: hashOAuthState(params.state),
      user_id: params.userId,
      purpose: params.purpose,
      return_to: params.returnTo ?? null,
      expires_at: expiresAt,
    });

    if (error) {
      console.warn('Failed to persist OAuth state server-side', error);
      return false;
    }

    // Opportunistic cleanup of long-expired rows; ignore failures.
    void admin
      .from('oauth_states')
      .delete()
      .lt('expires_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .then(
        () => undefined,
        () => undefined
      );

    return true;
  } catch (error) {
    console.warn('OAuth state storage unavailable (persist)', error);
    return false;
  }
}

/**
 * Atomically consume a state: marks it used only if it exists,
 * is unused, and has not expired. Then verifies it belongs to the
 * logged-in user.
 */
export async function consumeOAuthState(params: {
  userId: string;
  state: string;
  purpose: OAuthStatePurpose;
}): Promise<ConsumeOAuthStateResult> {
  try {
    const admin = createAdminClient();

    const { data, error } = await admin
      .from('oauth_states')
      .update({ used_at: new Date().toISOString() })
      .eq('state_hash', hashOAuthState(params.state))
      .eq('purpose', params.purpose)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('user_id');

    if (error) {
      console.warn('OAuth state storage unavailable (consume)', error);
      return 'unavailable';
    }

    const row = data?.[0];
    if (!row) return 'not_found';
    if (row.user_id !== params.userId) return 'user_mismatch';
    return 'ok';
  } catch (error) {
    console.warn('OAuth state storage unavailable (consume)', error);
    return 'unavailable';
  }
}
