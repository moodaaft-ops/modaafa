import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { partnersEnabled } from '@/lib/partners/config';
import { joinPartnerProgram } from '@/lib/partners/join';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  terms_required: 'لازم توافق على الشروط عشان تنضم.',
  bad_name: 'اكتب اسمك (من حرفين إلى 80 حرف).',
  bad_phone: 'رقم الجوال غير صحيح. اكتبه بالأرقام مع رمز الدولة، مثل 9665XXXXXXXX.',
  bad_code: 'الكود لازم يكون حروف إنجليزية صغيرة وأرقام (من 3 إلى 32)، وممكن فيه - أو _ بالنص.',
  reserved_code: 'هذا الكود محجوز، اختر غيره.',
  code_taken: 'هذا الكود مأخوذ، اختر غيره.',
  email_required: 'حسابك ما فيه إيميل مؤكد.',
  email_taken: 'هذا الإيميل مسجل عندنا كشريك بحساب ثاني. تواصل معنا.',
  unavailable: 'ما قدرنا نجهز لك كود الحين. أعد المحاولة.',
};

/**
 * POST /api/partners/join
 * Body: { display_name, phone, code?, accept_terms: true }
 * A signed-in user joins the partner programme. Off (404) unless PARTNERS_ENABLED=true.
 */
export async function POST(req: NextRequest) {
  if (!partnersEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const limit = await checkRateLimit({ req, scope: 'partners_join', limit: 10, windowSeconds: 3600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ ok: false, error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
  } catch {
    return NextResponse.json({ ok: false, error: 'security_service_unavailable' }, { status: 503 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_input' }, { status: 400 });
  }

  try {
    const result = await joinPartnerProgram(createAdminClient(), { id: user.id, email: user.email_confirmed_at ? user.email ?? null : null }, {
      displayName: body.display_name,
      phone: body.phone,
      code: body.code,
      acceptTerms: body.accept_terms,
    });
    if (!result.ok) {
      const status = result.error === 'code_taken' || result.error === 'email_taken' ? 409 : 400;
      return NextResponse.json({ ok: false, error: result.error, message: MESSAGES[result.error] ?? MESSAGES.unavailable }, { status });
    }
    return NextResponse.json({ ok: true, code: result.code, created: result.created });
  } catch (error) {
    console.error('[partners] join failed', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ ok: false, error: 'join_failed', message: 'صار خلل عندنا. أعد المحاولة بعد شوي.' }, { status: 500 });
  }
}
