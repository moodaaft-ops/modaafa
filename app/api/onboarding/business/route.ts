import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const payload =
    req.headers.get('content-type')?.includes('application/json')
      ? await req.json()
      : Object.fromEntries((await req.formData()).entries());

  const name = String(payload.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'business_name_required' }, { status: 400 });

  await supabase.from('users').upsert({
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
    avatar_url: user.user_metadata?.avatar_url ?? null,
    last_login_at: new Date().toISOString(),
  });

  const row = {
    user_id: user.id,
    name,
    sector: String(payload.sector ?? '').trim() || null,
    website: String(payload.website ?? '').trim() || null,
    primary_goal: String(payload.primary_goal ?? 'leads'),
    monthly_budget: Number(payload.monthly_budget || 0) || null,
    target_regions: String(payload.target_regions ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  };

  const { data: existing } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .single();

  const { error } = existing
    ? await supabase.from('businesses').update(row).eq('id', existing.id)
    : await supabase.from('businesses').insert(row);

  if (error) {
    console.error('Failed to save business onboarding', error);
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }

  if (req.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
    return NextResponse.redirect(new URL('/onboarding/connect', req.url), 303);
  }

  return NextResponse.json({ ok: true });
}
