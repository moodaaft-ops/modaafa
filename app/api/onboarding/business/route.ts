import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { name, sector, website } = body;

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return NextResponse.json({ error: 'اسم النشاط مطلوب' }, { status: 400 });
  }

  // Ensure a record exists in public.users (businesses.user_id has a FK to it).
  // Supabase Auth users live in auth.users; we mirror them into public.users
  // on-demand. id matches the auth user id so RLS policies line up.
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!existingUser) {
    const { error: userInsertError } = await supabase.from('users').insert({
      id: user.id,
      email: user.email ?? `${user.id}@placeholder.local`,
      name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
      avatar_url: user.user_metadata?.avatar_url ?? null,
    });
    if (userInsertError) {
      console.error('[onboarding/business] user insert failed:', userInsertError);
      return NextResponse.json(
        { error: 'فشل إنشاء حساب المستخدم' },
        { status: 500 }
      );
    }
  }

  // Check for existing business first (no UNIQUE constraint on user_id in the
  // businesses table, so we can't use upsert with onConflict here).
  const { data: existing } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  let error;
  if (existing) {
    ({ error } = await supabase
      .from('businesses')
      .update({
        name: name.trim(),
        sector: sector ?? null,
        website: website?.trim() || null,
      })
      .eq('id', existing.id));
  } else {
    ({ error } = await supabase.from('businesses').insert({
      user_id: user.id,
      name: name.trim(),
      sector: sector ?? null,
      website: website?.trim() || null,
    }));
  }

  if (error) {
    console.error('[onboarding/business] insert failed:', error);
    return NextResponse.json({ error: 'فشل حفظ البيانات' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
