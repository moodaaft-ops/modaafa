import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { createTimeBudget } from '@/lib/platform/concurrency';
import { finishJobRun, startJobRun } from '@/lib/platform/jobs';
import { isGuardEnabled } from '@/lib/guard/flag';
import { runGuard } from '@/lib/guard/run';

export const maxDuration = 300;

/** Leave ~40s of the 300s function budget for bookkeeping and the mail. */
const GUARD_BUDGET_MS = 260_000;

/**
 * الحارس الصباحي: the daily rules-only check of every connected account.
 * Scheduled once a day at 02:30 UTC (05:30 Riyadh) with a second slot as a
 * safety net: accounts already checked in the last 18 hours are skipped, so
 * the second slot only picks up what the first one missed.
 *
 * Does nothing (no reads, no writes, no mail) unless GUARD_ENABLED is "true" or
 * "operators". Answers 200 {"skipped":"disabled"} so the scheduler stays green.
 */
async function runRoute(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isGuardEnabled()) return NextResponse.json({ skipped: 'disabled' });

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  const url = new URL(req.url);
  const accountId = url.searchParams.get('account_id');
  const force = url.searchParams.get('force') === '1';
  const limit = Number(url.searchParams.get('limit') ?? '') || undefined;

  const job = await startJobRun(supabase, 'guard');
  if (job.alreadyRunning) return NextResponse.json({ skipped: 'already_running' }, { status: 409 });

  try {
    const summary = await runGuard({ supabase, budget: createTimeBudget(GUARD_BUDGET_MS) }, { accountId, force, limit });
    const failed = summary.accounts.failed > 0 || summary.mail.failed > 0;
    await finishJobRun({
      supabase,
      job,
      status: !failed ? 'success' : summary.accounts.checked > 0 ? 'partial' : 'failed',
      processed: summary.accounts.checked,
      errors: summary.errors,
      details: { accounts: summary.accounts, findings: summary.findings, mail: summary.mail },
    });
    return NextResponse.json(summary);
  } catch (error) {
    await finishJobRun({ supabase, job, status: 'failed', errors: [error] });
    console.error('guard run failed', error);
    return NextResponse.json({ error: 'guard_failed', message: describeError(error) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runRoute(req);
}

export async function POST(req: NextRequest) {
  return runRoute(req);
}
