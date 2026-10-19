import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders, resolveClientIp } from '@/lib/security/rate-limit';
import { ATTRIBUTION_COOKIE, parseAttributionCookie } from '@/lib/registration/attribution';
import { normalizePartnerCode, partnersEnabled, REF_COOKIE } from '@/lib/partners/config';
import { validateRegistration } from '@/lib/registration/validate';

/**
 * POST /api/register: step one of registration (name, email, phone).
 *
 * Nothing is created that lets the visitor into the platform. The details and
 * the campaign attribution are stored in the auth user's metadata and an email
 * link is sent; the registration completes (and the event is recorded) only
 * when the link is used and /register/finish runs. That is also why a typo'd
 * email can never produce a conversion.
 *
 * The response is the same whether the email is new or already registered, so
 * the form cannot be used to probe which emails have accounts.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ ok: false, error: 'invalid_origin' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const parsed = validateRegistration(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: 'validation', errors: parsed.errors }, { status: 400 });
  const { name, email, phoneE164 } = parsed.value;

  try {
    const byIp = await checkRateLimit({ req, scope: 'register_ip', limit: 10, windowSeconds: 600 });
    const byEmail = await checkRateLimit({ req, scope: 'register_email', limit: 3, windowSeconds: 600, identifier: email });
    const blocked = !byIp.allowed ? byIp : !byEmail.allowed ? byEmail : null;
    if (blocked) {
      return NextResponse.json({ ok: false, error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(blocked) });
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }

  try {
    const admin = createAdminClient();

    const { data: existing } = await admin
      .from('users')
      .select('id, registered_at')
      .eq('email', email)
      .maybeSingle();
    const alreadyRegistered = Boolean(existing?.registered_at);

    if (!alreadyRegistered) {
      const { data: taken } = await admin.rpc('registration_phone_taken', { p_phone_normalized: phoneE164 });
      if (taken === true) {
        return NextResponse.json({ ok: false, error: 'phone_taken' }, { status: 409 });
      }
    }

    const attribution = parseAttributionCookie(req.cookies.get(ATTRIBUTION_COOKIE)?.value);
    const metadata = {
      full_name: name,
      reg: {
        phone: phoneE164,
        attribution,
        // The partner link this visitor came through, kept next to the campaign
        // data so a referral that failed to attach can be repaired by hand.
        ref: partnersEnabled() ? normalizePartnerCode(req.cookies.get(REF_COOKIE)?.value) : null,
        client: {
          ip: resolveClientIp(req),
          ua: req.headers.get('user-agent')?.slice(0, 300) ?? null,
          ttp: req.cookies.get('_ttp')?.value ?? null,
        },
      },
    };

    // signInWithOtp only applies `data` when it CREATES the user. An earlier
    // unfinished attempt (wrong phone, closed tab) must pick up the new values.
    if (existing && !alreadyRegistered) {
      await admin.auth.admin.updateUserById(existing.id, { user_metadata: metadata });
    }

    const supabase = await createServerClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${req.nextUrl.origin}/auth/callback?next=${encodeURIComponent('/register/finish')}`,
        ...(alreadyRegistered ? {} : { data: metadata }),
      },
    });
    if (error) {
      console.warn('[api/register] otp failed', error.status ?? 'n/a');
      return NextResponse.json({ ok: false, error: 'email_failed' }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api/register] failed', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
}
