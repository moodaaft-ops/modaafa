import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, getRequestAuthContext } from '@/lib/supabase/server';
import { isOperatorUser } from '@/lib/platform/operators';
import { isSameOriginRequest } from '@/lib/security/origin';

/**
 * The operator marks a WhatsApp lead as contacted or dismissed. A plain form
 * POST from /operations/leads, answered with a redirect back to the list.
 *
 * Not an "operator action" in the sense of operator_audit_log (that log covers
 * changes to a customer's access and money). Here the row itself keeps who
 * did it and when (contacted_by, contacted_at).
 */
const NEXT_STATUS = { contacted: 'contacted', dismissed: 'dismissed', reopen: 'pending' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const back = (flag: string) => NextResponse.redirect(new URL(`/operations/leads?${flag}`, req.url), 303);
  if (!isSameOriginRequest(req)) return back('error=origin');

  const { user } = await getRequestAuthContext();
  // Same answer as a page that does not exist: a non-operator learns nothing.
  if (!isOperatorUser(user)) return new NextResponse(null, { status: 404 });

  const form = await req.formData().catch(() => null);
  const id = String(form?.get('id') ?? '');
  const to = String(form?.get('to') ?? '') as keyof typeof NEXT_STATUS;
  if (!UUID.test(id) || !(to in NEXT_STATUS)) return back('error=invalid');

  const status = NEXT_STATUS[to];
  const patch =
    status === 'pending'
      ? { whatsapp_status: status, contacted_at: null, contacted_by: null }
      : { whatsapp_status: status, contacted_at: new Date().toISOString(), contacted_by: user!.email };

  const { error } = await createAdminClient().from('visitor_leads').update(patch).eq('id', id).eq('channel', 'whatsapp');
  if (error) {
    console.error('[operations/leads] update failed', error.code, error.message);
    return back('error=save');
  }
  return back('ok=1');
}
