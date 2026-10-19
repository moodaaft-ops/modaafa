import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isOperatorUser } from '@/lib/platform/operators';
import { isSameOriginRequest } from '@/lib/security/origin';
import { agencyHandoffEnabled } from '@/lib/handoff/flag';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/operations/handoff { account_id }: the operator closes a handoff. Operators only. */
export async function POST(req: NextRequest) {
  if (!agencyHandoffEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOperatorUser({ id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null })) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { account_id?: unknown } | null;
  const accountId = String(body?.account_id ?? '');
  if (!UUID.test(accountId)) return NextResponse.json({ error: 'id_invalid' }, { status: 400 });

  const { error } = await createAdminClient()
    .from('agency_handoffs')
    .update({ handled_at: new Date().toISOString(), handled_by: user.id })
    .eq('account_id', accountId);
  if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
