import { NextRequest, NextResponse, after } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { isSimpleExperience } from '@/lib/setup/mode';
import { loadSetupState } from '@/lib/setup/load';
import { planScreenShown } from '@/lib/lifecycle/facts/plan-seen';
import { recordUserEvent } from '@/lib/stages/events';

export const dynamic = 'force-dynamic';

/** Re-read by the setup screen after the account choice and when the first audit lands. */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isSimpleExperience(process.env, user.email)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    const state = await loadSetupState(supabase, user, { edit: req.nextUrl.searchParams.get('edit') === '1' });
    // «خطتك جاهزة» is on its way to the screen: first_analysis_viewed, once per user (the database keeps the
    // first occurrence only), after the response, never throws.
    if (planScreenShown(state)) {
      after(() => recordUserEvent(user.id, 'first_analysis_viewed', { metadata: { page: 'onboarding' } }));
    }
    return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
}
