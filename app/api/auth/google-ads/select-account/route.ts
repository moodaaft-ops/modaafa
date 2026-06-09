import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';

type PendingCustomer = {
  customer_id: string;
  customer_name?: string | null;
  manager_id?: string | null;
  is_manager?: boolean;
  status?: string | null;
  currency_code?: string | null;
  time_zone?: string | null;
};

export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  const form = await req.formData();
  const sessionId = String(form.get('session_id') ?? '');
  const selectedIds = form
    .getAll('customer_id')
    .map((value) => String(value).replace(/-/g, ''))
    .filter(Boolean);

  if (!sessionId || selectedIds.length === 0) {
    return NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}&error=select_required`, req.url),
      303
    );
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .single();

  if (!business) {
    return NextResponse.redirect(new URL('/onboarding/business?error=no_business', req.url), 303);
  }

  const pendingCookie = req.cookies.get('gads_pending_session')?.value;
  const pending = parsePendingSession(pendingCookie);

  if (
    !pending ||
    pending.id !== sessionId ||
    pending.user_id !== user.id ||
    new Date(pending.expires_at).getTime() < Date.now()
  ) {
    return NextResponse.redirect(new URL('/onboarding/connect?error=session_expired', req.url), 303);
  }

  const customers = (pending.accessible_customers ?? []) as PendingCustomer[];
  const byId = new Map(customers.map((customer) => [customer.customer_id.replace(/-/g, ''), customer]));
  const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean) as PendingCustomer[];
  const linkable = selected.filter((customer) => !customer.is_manager);

  if (linkable.length === 0) {
    return NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}&error=manager_only`, req.url),
      303
    );
  }

  const rows = linkable.map((customer) => ({
    business_id: business.id,
    customer_id: customer.customer_id.replace(/-/g, ''),
    customer_name: customer.customer_name ?? null,
    manager_id: customer.manager_id ?? null,
    refresh_token_encrypted: pending.refresh_token_encrypted,
    permissions_scope: ['adwords'],
    status: 'active',
    currency_code: customer.currency_code ?? null,
    time_zone: customer.time_zone ?? null,
    last_synced_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('google_ads_accounts').upsert(rows, {
    onConflict: 'customer_id',
  });

  if (error) {
    console.error('Failed to link Google Ads accounts', error);
    return NextResponse.redirect(
      new URL(`/onboarding/select-account?session=${sessionId}&error=db_error`, req.url),
      303
    );
  }

  const res = NextResponse.redirect(new URL('/dashboard?connected=1', req.url), 303);
  res.cookies.delete('gads_pending_session');
  return res;
}

function parsePendingSession(value?: string) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
