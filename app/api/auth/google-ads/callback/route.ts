import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/google-ads/oauth';
import { discoverAccessibleCustomers, getCustomerMetadataWithFallback } from '@/lib/google-ads/client';
import { encrypt } from '@/lib/crypto';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import {
  normalizeCustomerId,
  pickPersistedOrPreferredGoogleAdsAccount,
  SELECTED_ADS_ACCOUNT_COOKIE,
} from '@/lib/accounts/selection';
import { syncCampaignCacheWithLoginFallback } from '@/lib/google-ads/sync';
import { handleGoogleLoginCallback, isGoogleLoginCallback } from '@/lib/auth/google-login-callback';
import { isGeneratedFallbackName } from '@/lib/accounts/display';
import {
  GOOGLE_ADS_OAUTH_STATE_COOKIE,
  hasGoogleAdsOAuthState,
} from '@/lib/auth/google-ads-oauth-state';
import { consumeOAuthState } from '@/lib/auth/oauth-state-store';
import { mapLimit } from '@/lib/platform/concurrency';

export const maxDuration = 300;

/** Google Ads enforces a per-developer-token QPS ceiling; stay well under it. */
const METADATA_CONCURRENCY = 6;

/**
 * Step 2: Google redirects back here after the user consents.
 *
 * We:
 * 1. Verify the CSRF state matches
 * 2. Exchange the code for tokens (we get a refresh_token)
 * 3. List which Google Ads customers this token can access
 * 4. Auto-link every non-manager customer account and let the user switch inside the dashboard.
 */
export async function GET(req: NextRequest) {
  if (isGoogleLoginCallback(req)) {
    return handleGoogleLoginCallback(req);
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    const errorUrl = new URL('/onboarding/connect', req.url);
    errorUrl.searchParams.set('error', error);
    return NextResponse.redirect(errorUrl);
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=missing_params', req.url));
  }

  // Auth check first: server-side state validation is tied to the user id.
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login?next=/onboarding/connect', req.url));
  }

  // Verify CSRF state.
  // Primary: server-side single-use state, bound to this user id (survives
  // slow consent screens, multi-tab retries, and host mismatches).
  //
  // The httpOnly cookie is a fallback for exactly one case: the state table
  // is unreachable (`unavailable`). It must NOT rescue `user_mismatch` or
  // `not_found` — the cookie is bound to the BROWSER, not to a user, and
  // holds several pending states at once. Accepting it on `user_mismatch`
  // meant that if user A started a link, signed out, and user B signed in on
  // the same browser before A finished consenting, A's refresh token and A's
  // ad accounts were written into B's business. That is a cross-tenant
  // credential leak, so those two results are now fatal.
  const serverStateResult = await consumeOAuthState({
    userId: user.id,
    state,
    purpose: 'google_ads_connect',
  });
  if (serverStateResult !== 'ok') {
    const cookieState = req.cookies.get(GOOGLE_ADS_OAUTH_STATE_COOKIE)?.value;
    const cookieValid =
      serverStateResult === 'unavailable' && hasGoogleAdsOAuthState(cookieState, state);
    if (!cookieValid) {
      console.warn(`Google Ads OAuth state rejected (server: ${serverStateResult})`);
      const res = NextResponse.redirect(
        new URL(
          `/onboarding/connect?error=${serverStateResult === 'user_mismatch' ? 'state_user_mismatch' : 'state_mismatch'}`,
          req.url
        )
      );
      // A rejected state must not stay replayable in the cookie.
      res.cookies.delete(GOOGLE_ADS_OAUTH_STATE_COOKIE);
      return res;
    }
  }

  try {
    // Exchange code → tokens
    const tokens = await exchangeCodeForTokens(code);
    const refreshToken = tokens.refresh_token!;

    // Discover direct accounts and MCC children without pulling manager metrics.
    const accounts = await discoverAccessibleCustomers(refreshToken);

    if (accounts.length === 0) {
      return NextResponse.redirect(new URL('/onboarding/connect?error=no_accounts', req.url));
    }

    await ensureUserProfile(user);
    const business = await getOrCreateUserBusiness(supabase, user);
    if (!business) {
      return NextResponse.redirect(new URL('/onboarding/business?error=no_business', req.url));
    }

    const encryptedRefreshToken = encrypt(refreshToken);
    const enrichedAccounts = await enrichLinkableAccounts(
      refreshToken,
      accounts.filter((account) => !account.is_manager),
      accounts
    );

    // Re-apply the manager filter AFTER enrichment: metadata read during
    // enrichment can reveal that an account discovery flagged as a client is
    // in fact an MCC. Linking one means every later sync asks Google for
    // metrics on a manager and gets REQUESTED_METRICS_FOR_MANAGER forever.
    const linkableAccounts = enrichedAccounts.filter((account) => account.is_manager !== true);

    if (linkableAccounts.length === 0) {
      return NextResponse.redirect(new URL('/onboarding/connect?error=no_client_accounts', req.url));
    }

    const existingMetadata = await loadExistingAccountMetadata(supabase, business.id);
    const rows = linkableAccounts.map((account) => ({
      business_id: business.id,
      customer_id: normalizeCustomerId(account.customer_id),
      customer_name:
        account.customer_name ??
        validExistingName(existingMetadata.get(normalizeCustomerId(account.customer_id))?.customer_name) ??
        null,
      manager_id:
        account.manager_id ??
        existingMetadata.get(normalizeCustomerId(account.customer_id))?.manager_id ??
        null,
      refresh_token_encrypted: encryptedRefreshToken,
      permissions_scope: ['adwords'],
      status: 'active',
      currency_code:
        account.currency_code ??
        existingMetadata.get(normalizeCustomerId(account.customer_id))?.currency_code ??
        null,
      time_zone:
        account.time_zone ??
        existingMetadata.get(normalizeCustomerId(account.customer_id))?.time_zone ??
        null,
      is_manager: account.is_manager === true,
      google_status: account.status ?? null,
      // Deliberately NOT stamped here. Only the preferred account is synced
      // below; stamping every row made "آخر تحديث" lie for the rest and made
      // the nightly cron de-prioritise accounts that had never synced at all.
    }));

    let admin;
    try {
      admin = createAdminClient();
    } catch (adminError) {
      console.error('Google Ads linking service is unavailable', adminError);
      return NextResponse.redirect(
        new URL('/onboarding/connect?error=security_service_unavailable', req.url)
      );
    }

    // Account creation and credential/link-state updates are service-owned.
    // Browser roles only retain RLS-scoped access to harmless display/sync
    // metadata after the security-hardening migration.
    const { data: savedAccounts, error: linkError } = await admin
      .from('google_ads_accounts')
      .upsert(rows, { onConflict: 'business_id,customer_id' })
      .select('id, customer_id, customer_name, manager_id, currency_code, refresh_token_encrypted');

    if (linkError) {
      console.error('Failed to auto-link Google Ads accounts', linkError);
      return NextResponse.redirect(new URL('/onboarding/connect?error=db_error', req.url));
    }

    const selectedAccount = pickPersistedOrPreferredGoogleAdsAccount(
      savedAccounts,
      business.selected_google_ads_customer_id,
      linkableAccounts
    );
    if (selectedAccount) {
      if (!business.selected_google_ads_customer_id) {
        const selectedCustomerId = normalizeCustomerId(selectedAccount.customer_id);
        const { error: preferenceError } = await supabase
          .from('businesses')
          .update({ selected_google_ads_customer_id: selectedCustomerId })
          .eq('id', business.id)
          .eq('user_id', user.id);
        if (preferenceError) {
          console.warn('Unable to persist initial Google Ads account selection', preferenceError);
        } else {
          business.selected_google_ads_customer_id = selectedCustomerId;
        }
      }

      try {
        const syncResult = await syncCampaignCacheWithLoginFallback({
          supabase,
          customerId: selectedAccount.customer_id,
          refreshToken,
          accountId: selectedAccount.id,
          currencyCode: selectedAccount.currency_code,
          loginCustomerIds: [selectedAccount.manager_id],
        });
        if (syncResult.loginCustomerId) {
          await supabase
            .from('google_ads_accounts')
            .update({ manager_id: syncResult.loginCustomerId })
            .eq('id', selectedAccount.id);
        }
      } catch (syncError) {
        console.warn(`Initial campaign sync failed for ${selectedAccount.customer_id}`, syncError);
      }
    }

    const res = NextResponse.redirect(
      new URL(`/dashboard?connected=1&accounts=${savedAccounts?.length ?? linkableAccounts.length}`, req.url)
    );
    res.cookies.delete(GOOGLE_ADS_OAUTH_STATE_COOKIE);
    if (selectedAccount?.customer_id) {
      res.cookies.set(SELECTED_ADS_ACCOUNT_COOKIE, normalizeCustomerId(selectedAccount.customer_id), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 90,
        path: '/',
      });
    }
    return res;
  } catch (err) {
    console.error('OAuth callback error', err);
    return NextResponse.redirect(new URL('/onboarding/connect?error=oauth_failed', req.url));
  }
}

async function getOrCreateUserBusiness(
  supabase: any,
  user: { id: string; email?: string | null; user_metadata?: Record<string, any> }
) {
  const { data: existing, error: lookupError } = await supabase
    .from('businesses')
    .select('id, selected_google_ads_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.warn('Failed to look up business before Google Ads linking', lookupError);
    return null;
  }

  if (existing) return existing;

  const fallbackName =
    user.user_metadata?.business_name ??
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split('@')[0] ??
    'نشاطي';

  // Upsert on the (new) unique user_id so a request racing the onboarding
  // form cannot create a second workspace. A second businesses row silently
  // orphaned every linked ad account, because each reader takes the newest
  // business — that is what sent returning users back to onboarding.
  const { data: created, error: createError } = await supabase
    .from('businesses')
    .upsert(
      {
        user_id: user.id,
        name: fallbackName,
        primary_goal: 'leads',
        target_regions: [],
      },
      { onConflict: 'user_id', ignoreDuplicates: true }
    )
    .select('id, selected_google_ads_customer_id')
    .maybeSingle();

  if (createError) {
    console.warn('Failed to create fallback business before Google Ads linking', createError);
    return null;
  }

  if (created) return created;

  // ignoreDuplicates returns no row when the business already existed.
  const { data: reread } = await supabase
    .from('businesses')
    .select('id, selected_google_ads_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return reread ?? null;
}

function validExistingName(name?: string | null) {
  const trimmed = name?.trim();
  return trimmed && !isGeneratedFallbackName(trimmed) ? trimmed : null;
}

async function ensureUserProfile(user: { id: string; email?: string | null; user_metadata?: Record<string, any> }) {
  try {
    const admin = createAdminClient();
    await admin.from('users').upsert({
      id: user.id,
      email: user.email,
      name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
      avatar_url: user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? null,
      last_login_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Unable to ensure public user profile before Google Ads linking', error);
  }
}

async function enrichLinkableAccounts(
  refreshToken: string,
  linkableAccounts: Awaited<ReturnType<typeof discoverAccessibleCustomers>>,
  allAccounts: Awaited<ReturnType<typeof discoverAccessibleCustomers>>
) {
  const loginCandidates = [
    ...allAccounts
      .flatMap((account) => [account.manager_id, account.is_manager ? account.customer_id : null])
      .filter((value): value is string => Boolean(value)),
  ].filter((value, index, values) => values.indexOf(value) === index);

  return mapLimit(linkableAccounts, METADATA_CONCURRENCY, async (account) => {
      if (account.customer_name && account.currency_code && account.time_zone) return account;

      try {
        const normalizedCustomerId = normalizeCustomerId(account.customer_id);
        const { metadata, loginCustomerId } = await getCustomerMetadataWithFallback(
          refreshToken,
          normalizedCustomerId,
          [account.manager_id, ...loginCandidates].filter((value): value is string => Boolean(value))
        );

        return {
          ...account,
          customer_id: metadata.customer_id,
          customer_name: account.customer_name ?? metadata.customer_name,
          manager_id:
            account.manager_id ??
            (loginCustomerId && loginCustomerId !== normalizedCustomerId ? loginCustomerId : null),
          // `account.is_manager` is always a boolean coming out of discovery,
          // so `??` never fires. Take the freshly-read metadata whenever it
          // says "manager" — that is the value we then filter on.
          is_manager: metadata.is_manager || account.is_manager || false,
          currency_code: account.currency_code ?? metadata.currency_code,
          time_zone: account.time_zone ?? metadata.time_zone,
        };
      } catch (error) {
        console.warn(`Failed to enrich Google Ads account ${account.customer_id} during OAuth callback`, error);
        return account;
      }
    });
}

/**
 * Reads the metadata already stored for this business so a re-connect
 * never blanks a name the user typed by hand.
 *
 * Deliberately throws instead of returning an empty map: swallowing the
 * error meant a transient read failure wrote NULL over every
 * `customer_name`, `manager_id`, `currency_code` and `time_zone` in the
 * upsert that follows. Also pages explicitly — the PostgREST default of
 * 1000 rows silently truncated large agency accounts into the same wipe.
 */
async function loadExistingAccountMetadata(supabase: any, businessId: string) {
  const pageSize = 500;
  const result = new Map<string, any>();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('google_ads_accounts')
      .select('customer_id, customer_name, manager_id, currency_code, time_zone')
      .eq('business_id', businessId)
      .order('customer_id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to load existing Google Ads account metadata: ${error.message ?? error}`);
    }

    for (const account of data ?? []) {
      result.set(normalizeCustomerId(account.customer_id), {
        customer_name: account.customer_name ?? null,
        manager_id: account.manager_id ?? null,
        currency_code: account.currency_code ?? null,
        time_zone: account.time_zone ?? null,
      });
    }

    if (!data || data.length < pageSize) break;
  }

  return result;
}
