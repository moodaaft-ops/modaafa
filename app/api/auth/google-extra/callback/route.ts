import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { consumeOAuthState } from '@/lib/auth/oauth-state-store';
import { isExtraFeatureEnabled, statePurposeFor } from '@/lib/google-auth/features';
import { exchangeExtraCode } from '@/lib/google-auth/incremental';
import { callbackRedirect, evaluateGrant, parseExtraState } from '@/lib/google-auth/state';
import { saveGrant } from '@/lib/google-auth/store';

/**
 * Step 2 of a separate Google consent. Order matters: the state is consumed
 * (single use, same user) BEFORE the one-time code is exchanged, the returned
 * scope is checked against the feature, and only then is the refresh token
 * encrypted and stored. The token never reaches the browser.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');
  const parsed = parseExtraState(rawState);
  const go = (outcome: string) => NextResponse.redirect(new URL(callbackRedirect(parsed?.feature ?? null, outcome), req.url), 303);

  if (!parsed || !isExtraFeatureEnabled(parsed.feature)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (url.searchParams.get('error')) return go('declined');
  if (!code || !rawState) return go('missing_params');

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login?next=/settings', req.url));

  const consumed = await consumeOAuthState({
    userId: user.id,
    state: rawState,
    purpose: statePurposeFor(parsed.feature) as Parameters<typeof consumeOAuthState>[0]['purpose'],
  });
  if (consumed !== 'ok') return go(consumed === 'user_mismatch' ? 'state_user_mismatch' : 'state_invalid');

  try {
    const tokens = await exchangeExtraCode(code);
    const verdict = evaluateGrant(parsed.feature, { scope: tokens.scope, refresh_token: tokens.refresh_token });
    if (!verdict.ok) return go(verdict.reason);
    await saveGrant(createAdminClient(), {
      userId: user.id,
      feature: parsed.feature,
      refreshToken: tokens.refresh_token as string,
      scopes: verdict.scopes,
    });
  } catch (error) {
    console.error('Google extra grant failed', error instanceof Error ? error.message : 'unknown');
    return go('oauth_failed');
  }
  return go('connected');
}
