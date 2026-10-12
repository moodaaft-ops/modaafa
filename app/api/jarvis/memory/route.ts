import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** «وش أعرف عن نشاطك»: the owner's active facts, read through RLS. */
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: business } = await supabase.from('businesses').select('id').eq('user_id', user.id).maybeSingle();
  if (!business) return NextResponse.json({ facts: [] });
  const { data, error } = await supabase
    .from('business_memory')
    .select('id, kind, fact_ar, source, basis, created_at')
    .eq('business_id', business.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: 'memory_unavailable' }, { status: 503 });
  return NextResponse.json({ facts: data ?? [] });
}

/**
 * Deletes one fact as a status change. Ownership is proven by reading the row
 * through the caller's RLS client first; the write then uses the service role
 * scoped to that exact row and business.
 */
export async function DELETE(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rl = await checkRateLimit({ req, scope: 'jarvis_memory', limit: 30, windowSeconds: 600, identifier: user.id });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id : '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { data: fact } = await supabase.from('business_memory').select('id, business_id').eq('id', id).maybeSingle();
  if (!fact) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const { error } = await admin
    .from('business_memory')
    .update({ status: 'deleted', updated_at: new Date().toISOString() })
    .eq('id', fact.id)
    .eq('business_id', fact.business_id);
  if (error) return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
