import { NextResponse, type NextRequest } from 'next/server';
import { isMonthlyReviewEnabled } from '@/lib/loops/flags';
import { listMonthlyAccounts } from '@/lib/loops/monthly-accounts';
import { runMonthlyReview } from '@/lib/loops/monthly-run';
import { finishJobRun, startJobRun } from '@/lib/platform/jobs';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';

/**
 * The monthly deep session (MONTHLY_REVIEW_ENABLED, off by default).
 * Scheduled for the first days of the month; each account gets one report per
 * month, so a repeat call does nothing for accounts already done.
 * ?force=1 allows a run outside the first days of the month.
 * Everything that matters is in lib/loops/monthly-run.ts.
 */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isMonthlyReviewEnabled()) {
    return NextResponse.json({ skipped: 'disabled' });
  }

  let supabase: any;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  const job = await startJobRun(supabase, 'monthly-review');
  if (job.alreadyRunning) return NextResponse.json({ skipped: 'already_running' }, { status: 409 });

  try {
    const summary = await runMonthlyReview({
      supabase,
      listAccounts: listMonthlyAccounts(supabase),
      force: req.nextUrl.searchParams.get('force') === '1',
    });
    await finishJobRun({
      supabase,
      job,
      status: summary.failed > 0 ? 'partial' : 'success',
      processed: summary.reported,
      details: {
        month: summary.month ?? null,
        reason: summary.reason ?? null,
        considered: summary.considered,
        reported: summary.reported,
        skipped: summary.skipped,
        failed: summary.failed,
        model_calls: summary.model_calls,
        model_cost_usd: summary.model_cost_usd,
      },
    });
    // Per-account results carry account ids only; still keep them out of the response body.
    const { results: _results, ...safe } = summary;
    return NextResponse.json(safe);
  } catch (error) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [error] });
    return NextResponse.json({ error: 'monthly_review_failed', message: describeError(error) }, { status: 500 });
  }
}
