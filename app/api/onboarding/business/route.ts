import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/onboarding/business?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // This endpoint is reached by a native form POST, so returning JSON here
    // painted a bare `{"error":"unauthorized"}` page with no way back.
    if (isFormRequest(req)) {
      return NextResponse.redirect(new URL('/login?next=/onboarding/business', req.url), 303);
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'business_onboarding', limit: 10, windowSeconds: 300, identifier: user.id });
    if (!rateLimit.allowed) {
      return respond(req, 'too_many_requests', 429, rateLimitHeaders(rateLimit));
    }
  } catch {
    return respond(req, 'security_service_unavailable', 503);
  }

  const payload =
    req.headers.get('content-type')?.includes('application/json')
      ? await req.json()
      : Object.fromEntries((await req.formData()).entries());

  const name = String(payload.name ?? '').trim();
  if (!name || name.length > 120) return respond(req, 'business_name_required', 400);

  const website = String(payload.website ?? '').trim();
  if (website && !isSafeWebsite(website)) {
    return respond(req, 'invalid_website', 400);
  }
  const monthlyBudget = Number(payload.monthly_budget || 0);
  if (!Number.isFinite(monthlyBudget) || monthlyBudget < 0 || monthlyBudget > 1_000_000_000) {
    return respond(req, 'invalid_monthly_budget', 400);
  }
  const primaryGoal = String(payload.primary_goal ?? 'leads');
  if (!['leads', 'conversions', 'traffic', 'awareness'].includes(primaryGoal)) {
    return respond(req, 'invalid_primary_goal', 400);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (adminError) {
    console.error('User profile service is unavailable', adminError);
    return respond(req, 'security_service_unavailable', 503);
  }

  // Identity/profile writes are service-owned. Always use the email returned
  // by Supabase Auth rather than accepting identity fields from the request.
  const { error: profileError } = await admin.from('users').upsert({
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
    avatar_url: user.user_metadata?.avatar_url ?? null,
    last_login_at: new Date().toISOString(),
  });
  if (profileError) {
    console.error('Failed to save the authenticated user profile', profileError);
    return respond(req, 'save_failed', 500);
  }

  const row = {
    user_id: user.id,
    name,
    sector: String(payload.sector ?? '').trim() || null,
    website: website || null,
    primary_goal: primaryGoal,
    monthly_budget: monthlyBudget || null,
    target_regions: String(payload.target_regions ?? '')
      // Support Arabic comma (،) and newlines in addition to the Latin comma.
      .split(/[,،\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  };

  // One workspace per user, enforced by the unique index on
  // businesses(user_id). The previous read-then-insert let a double submit
  // create a second business; every reader takes the newest one, so the
  // user's already-linked ad accounts became invisible and the app pushed
  // them back through onboarding.
  const { error } = await supabase
    .from('businesses')
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    console.error('Failed to save business onboarding', error);
    return respond(req, 'save_failed', 500);
  }

  if (isFormRequest(req)) {
    return NextResponse.redirect(new URL('/onboarding/connect', req.url), 303);
  }

  return NextResponse.json({ ok: true });
}

function isFormRequest(req: NextRequest) {
  return Boolean(req.headers.get('content-type')?.includes('application/x-www-form-urlencoded'));
}

function respond(
  req: NextRequest,
  error: string,
  status: number,
  headers?: Record<string, string>
) {
  if (isFormRequest(req)) {
    const url = new URL('/onboarding/business', req.url);
    url.searchParams.set('error', error);
    return NextResponse.redirect(url, 303);
  }
  return NextResponse.json({ error }, { status, headers });
}

function isSafeWebsite(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}
