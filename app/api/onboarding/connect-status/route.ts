import { NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getUserBusinessWithClient } from '@/lib/accounts/selection';
import {
  connectJobName,
  isConnectJobTimedOut,
  resolveConnectProgress,
  type ConnectJobSnapshot,
} from '@/lib/onboarding/connect-progress';

export const dynamic = 'force-dynamic';

/**
 * Polled by /onboarding/preparing. Reads only the caller's own connect job
 * (the job name embeds the authenticated user id) and returns stage names,
 * never the raw row.
 */
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const jobName = connectJobName(user.id);
  const { data, error } = await admin
    .from('job_runs')
    .select('id, status, started_at, finished_at, details')
    .eq('job_name', jobName)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const snapshot = (data ?? null) as (ConnectJobSnapshot & { id: string }) | null;

  // A killed invocation never records its own end. Close the row so the
  // next consent is not blocked and the screen can say what happened.
  if (snapshot && isConnectJobTimedOut(snapshot)) {
    await admin
      .from('job_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: 'timeout: the connect job did not finish inside the function limit',
        details: { ...(snapshot.details ?? {}), error: 'timeout' },
      })
      .eq('id', snapshot.id)
      .eq('status', 'running');
  }

  const view = resolveConnectProgress(snapshot);

  // After a timeout or failure, accounts saved before the stop are still
  // usable, so the screen can offer to continue with them.
  let linkedAccounts = 0;
  if (view.phase === 'failed' || view.phase === 'timed_out') {
    const business = await getUserBusinessWithClient(supabase, user.id).catch(() => null);
    if (business) {
      const { count } = await supabase
        .from('google_ads_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('status', 'active')
        .not('is_manager', 'is', true);
      linkedAccounts = count ?? 0;
    }
  }

  return NextResponse.json(
    { ...view, linkedAccounts },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
