import { NextResponse, type NextRequest } from 'next/server';
import { finishJobRun, startJobRun } from '@/lib/platform/jobs';
import { runEmailLifecycle, type LifecycleRunOptions, type LifecycleRunSummary } from '@/lib/lifecycle/run';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';

/**
 * The logic behind GET /api/cron/email-lifecycle, kept out of the route file so
 * it can be tested (a Next route file may only export route fields).
 *
 *   - Authorization: Bearer <CRON_SECRET>, same as every other cron.
 *   - ?dry=1  plans and reports; sends nothing, writes nothing. Works while the
 *     feature is still off. Two preview-only parameters:
 *       activated_at=<ISO>   pretend this is the activation moment
 *       assume_approved=1    pretend every copy and broadcast is approved
 *     (both are ignored on a real run, so they cannot send anything)
 *   - A real run needs EMAIL_LIFECYCLE_ENABLED=true, otherwise 503.
 *
 * Meant to be called every 10 minutes (db/proposals/20261014_email_lifecycle_cron.sql).
 */
export type CronDeps = {
  createAdmin?: () => unknown;
  run?: (options: LifecycleRunOptions) => Promise<LifecycleRunSummary>;
  startJob?: typeof startJobRun;
  finishJob?: typeof finishJobRun;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export async function handleEmailLifecycleCron(req: NextRequest, deps: CronDeps = {}): Promise<NextResponse> {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const env = deps.env ?? process.env;
  const params = req.nextUrl.searchParams;
  const dryRun = params.get('dry') === '1';
  if (!dryRun && env.EMAIL_LIFECYCLE_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'disabled' }, { status: 503 });
  }

  let activatedAtOverride: string | undefined;
  if (dryRun && params.get('activated_at')) {
    const raw = params.get('activated_at') as string;
    if (!Number.isFinite(Date.parse(raw))) {
      return NextResponse.json({ error: 'bad_activated_at' }, { status: 400 });
    }
    activatedAtOverride = new Date(raw).toISOString();
  }

  let admin: unknown;
  try {
    admin = (deps.createAdmin ?? createAdminClient)();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  const run = deps.run ?? runEmailLifecycle;
  const now = deps.now?.();

  if (dryRun) {
    try {
      const summary = await run({
        admin,
        now,
        dryRun: true,
        config: {
          ...(activatedAtOverride ? { activatedAt: activatedAtOverride } : {}),
          assumeApproved: params.get('assume_approved') === '1',
        },
      });
      return NextResponse.json(summary);
    } catch (error) {
      return NextResponse.json({ error: 'dry_run_failed', message: describeError(error) }, { status: 500 });
    }
  }

  const job = await (deps.startJob ?? startJobRun)(admin, 'email-lifecycle');
  if (job.alreadyRunning) {
    return NextResponse.json({ skipped: 'already_running' }, { status: 409 });
  }

  const finish = deps.finishJob ?? finishJobRun;
  try {
    const summary = await run({ admin, now });
    await finish({
      supabase: admin,
      job,
      status: summary.failed > 0 || summary.timeBudgetExceeded || summary.notConfigured ? 'partial' : 'success',
      processed: summary.sent,
      details: {
        gate: summary.gate,
        considered: summary.considered,
        planned: summary.planned.total,
        sent: summary.sent,
        failed: summary.failed,
        skipped: summary.skipped,
        duplicate: summary.duplicate,
        skipsRecorded: summary.skips.recorded,
        notConfigured: summary.notConfigured,
        timeBudgetExceeded: summary.timeBudgetExceeded,
      },
    });
    // The per-user lists stay out of the response: cron callers log bodies.
    const { results: _results, sample: _sample, ...safe } = summary;
    return NextResponse.json(safe);
  } catch (error) {
    await finish({ supabase: admin, job, status: 'failed', errors: [error] });
    return NextResponse.json({ error: 'email_lifecycle_failed', message: describeError(error) }, { status: 500 });
  }
}
