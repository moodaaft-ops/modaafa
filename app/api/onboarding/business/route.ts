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

  const { error } = await supabase.from('businesses').upsert({
    user_id: user.id,
    name: name.trim(),
    sector: sector ?? null,
    website: website?.trim() || null,
  }, { onConflict: 'user_id' });

  if (error) {
    console.error('[onboarding/business] insert failed:', error);
    return NextResponse.json({ error: 'فشل حفظ البيانات' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
