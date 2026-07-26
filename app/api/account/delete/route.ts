import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { cancelStripeSubscription } from '@/lib/billing/stripe';
import { decrypt } from '@/lib/crypto';
import { revokeRefreshToken } from '@/lib/google-ads/oauth';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { clearModaafaCookies } from '@/lib/auth/session-cookies';
import { isSameOriginRequest } from '@/lib/security/origin';

const REQUIRED_CONFIRMATION = 'حذف حسابي';

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/settings?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'account_delete', limit: 3, windowSeconds: 3600, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const contentType = req.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await req.json().catch(() => ({}))
    : Object.fromEntries((await req.formData()).entries());
  const confirmation = String(payload.confirmation ?? '').trim();

  if (confirmation !== REQUIRED_CONFIRMATION) {
    const url = new URL('/settings', req.url);
    url.searchParams.set('delete_error', 'confirmation_required');
    return NextResponse.redirect(url, 303);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    console.error('Account deletion requires Supabase service role', error);
    const url = new URL('/settings', req.url);
    url.searchParams.set('delete_error', 'service_role_missing');
    return NextResponse.redirect(url, 303);
  }

  const { data: subscriptions, error: subscriptionsError } = await admin
    .from('subscriptions')
    .select('id, stripe_subscription_id')
    .eq('user_id', user.id)
    .in('status', ['trialing', 'active', 'past_due', 'paused']);
  if (subscriptionsError) {
    console.error('Failed to inspect subscriptions before account deletion', subscriptionsError);
    return deleteError(req, 'billing_check_failed');
  }

  for (const subscription of subscriptions ?? []) {
    const subscriptionId = subscription.stripe_subscription_id;
    if (!subscriptionId) {
      console.error('Cannot safely delete an account with an untracked live subscription');
      return deleteError(req, 'billing_cancellation_required');
    }
    try {
      await cancelStripeSubscription(subscriptionId);
    } catch (error) {
      // Treat "already gone" as success. Previously, a failure AFTER a
      // successful cancel (e.g. the row delete below) left the local row
      // `active`, and the retry called cancel() on an already-cancelled
      // subscription — Stripe answered `resource_missing`, the request
      // aborted, and the account could never be deleted through the UI again.
      if (!isAlreadyCancelledStripeError(error)) {
        console.error('Failed to cancel Stripe subscription before account deletion', {
          subscriptionId,
          error,
        });
        return deleteError(req, 'billing_cancellation_failed');
      }
    }

    // Mark it locally straight away so a retry skips it entirely.
    await admin
      .from('subscriptions')
      .update({ status: 'canceled', canceled_at: new Date().toISOString() })
      .eq('id', subscription.id);
  }

  const { data: businesses } = await admin
    .from('businesses')
    .select('id')
    .eq('user_id', user.id);
  const businessIds = (businesses ?? []).map((business) => business.id).filter(Boolean);
  const { data: adAccounts } = businessIds.length
    ? await admin
        .from('google_ads_accounts')
        .select('refresh_token_encrypted')
        .in('business_id', businessIds)
    : { data: [] };

  const refreshTokens = new Set<string>();
  let decryptFailures = 0;
  for (const account of adAccounts ?? []) {
    const encrypted = account.refresh_token_encrypted;
    if (!encrypted) continue;
    try {
      refreshTokens.add(decrypt(encrypted));
    } catch (error) {
      decryptFailures += 1;
      console.error('Failed to decrypt Google Ads refresh token before account deletion', error);
    }
  }

  // Revocation is a BLOCKING step, not best-effort.
  //
  // It used to be wrapped in a `catch` that only logged, after which the rows
  // — and with them the only copy of `refresh_token_encrypted` — were deleted
  // anyway. Modaafa was then holding a live, offline-access grant on the
  // user's Google Ads account that neither they nor we could ever revoke,
  // while the privacy page and the deletion screen both promise the opposite.
  for (const refreshToken of refreshTokens) {
    try {
      await revokeRefreshToken(refreshToken);
    } catch (error) {
      // Google answers 400 invalid_token when the grant is already gone.
      if (isAlreadyRevokedGoogleError(error)) continue;
      console.error('Failed to revoke Google OAuth grant before account deletion', error);
      return deleteError(req, 'google_revoke_failed');
    }
  }

  if (decryptFailures > 0) {
    // A token we cannot decrypt is a token we cannot revoke. Deleting the row
    // would strand the grant forever, so stop and let an operator look.
    console.error('Refusing to delete account: some Google refresh tokens could not be decrypted', {
      userId: user.id,
      decryptFailures,
    });
    return deleteError(req, 'google_revoke_failed');
  }

  // Delete the AUTH user first and let `users.id → auth.users(id) ON DELETE
  // CASCADE` remove the tenant tree in one database operation. The old order
  // (rows first, auth user second) left a window where the auth identity
  // survived: the `on_auth_user_created` trigger fires on the next sign-in
  // (GoTrue updates last_sign_in_at) and silently re-created an empty
  // `public.users` row — a "deleted" account coming back as a shell.
  const { error: deleteAuthError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteAuthError) {
    console.error('Failed to delete Supabase auth user', deleteAuthError);
    const url = new URL('/settings', req.url);
    url.searchParams.set('delete_error', 'auth_delete_failed');
    return NextResponse.redirect(url, 303);
  }

  // Belt and braces: if the FK/cascade is missing in this environment, remove
  // the profile explicitly. A no-op when the cascade already did its job.
  const { error: deleteProfileError } = await admin.from('users').delete().eq('id', user.id);
  if (deleteProfileError) {
    console.error('Modaafa user profile survived auth deletion', deleteProfileError);
  }

  await supabase.auth.signOut();

  return clearModaafaCookies(
    NextResponse.redirect(new URL('/login?account_deleted=1', req.url), 303)
  );
}

function isAlreadyCancelledStripeError(error: unknown) {
  const code = (error as { code?: string; raw?: { code?: string } })?.code
    ?? (error as { raw?: { code?: string } })?.raw?.code;
  if (code === 'resource_missing') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('no such subscription') || message.includes('already canceled');
}

function isAlreadyRevokedGoogleError(error: unknown) {
  const status = (error as { response?: { status?: number }; status?: number })?.response?.status
    ?? (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return status === 400 && (message.includes('invalid_token') || message.includes('invalid token'));
}

function deleteError(req: NextRequest, code: string) {
  const url = new URL('/settings', req.url);
  url.searchParams.set('delete_error', code);
  return NextResponse.redirect(url, 303);
}
