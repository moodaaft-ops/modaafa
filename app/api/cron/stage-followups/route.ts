import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { finishJobRun, startJobRun } from '@/lib/platform/jobs';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { runStageFollowups } from '@/lib/stages/run-followups';

/**
 * Sends the stage follow-up emails (see config/stage-followups.ts).
 *
 * Off by default. A real run needs STAGE_FOLLOWUPS_ENABLED=true; without it
 * the route answers {"skipped":"disabled"} and touches nothing.
 *
 * ?dry=1 plans and reports who WOULD receive what, sends nothing and writes
 * nothing. It works while the feature is still off, so the schedule can be
 * checked before anything is switched on.
 *
 * Meant to be called every 5 to 10 minutes: the shortest step is 15 minutes.
 */
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  if (!dryRun && process.env.STAGE_FOLLOWUPS_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  if (dryRun) {
    try {
      return NextResponse.json(await runStageFollowups({ admin, dryRun: true }));
    } catch (error) {
      return NextResponse.json({ error: 'dry_run_failed', message: describeError(error) }, { status: 500 });
    }
  }

  const job = await startJobRun(admin, 'stage-followups');
  if (job.alreadyRunning) {
    return NextResponse.json({ skipped: 'already_running' }, { status: 409 });
  }

  try {
    const summary = await runStageFollowups({ admin });
    await finishJobRun({
      supabase: admin,
      job,
      status: summary.failed > 0 ? 'partial' : 'success',
      processed: summary.sent,
      details: {
        considered: summary.considered,
        planned: summary.planned.length,
        sent: summary.sent,
        failed: summary.failed,
        skippedByGuard: summary.skippedByGuard,
        superseded: summary.supersededRecorded,
      },
    });
    // The per-user list stays out of the response: cron callers log bodies.
    const { results: _results, planned: _planned, ...safe } = summary;
    return NextResponse.json({ ...safe, planned: summary.planned.length });
  } catch (error) {
    await finishJobRun({ supabase: admin, job, status: 'failed', errors: [error] });
    return NextResponse.json({ error: 'followups_failed', message: describeError(error) }, { status: 500 });
  }
}
