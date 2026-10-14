import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { createOAuthCallbackHandler } from '../lib/auth/oauth-callback-handler';
import { handleEmailLifecycleCron, type CronDeps } from '../lib/lifecycle/cron';
import { emptyIgnored } from '../lib/lifecycle/plan';
import type { LifecycleRunOptions, LifecycleRunSummary } from '../lib/lifecycle/run';
import type { RegistrationDb } from '../lib/registration/finalize';
import { finalizeForRequest } from '../lib/registration/service';

const SECRET = 'lifecycle-test-secret';

function request(query = '', authorization: string | null = `Bearer ${SECRET}`) {
  return new NextRequest(`https://ai.modaafa.com/api/cron/email-lifecycle${query}`, {
    headers: authorization ? { authorization } : undefined,
  });
}

function summary(overrides: Partial<LifecycleRunSummary> = {}): LifecycleRunSummary {
  return {
    dryRun: false,
    gate: 'open',
    activatedAt: '2026-10-01T00:00:00+03:00',
    considered: 12,
    planned: { total: 4, thisRun: 4, byTemplate: { registered_1d: 4 }, byKind: { journey: 4, weekly: 0, broadcast: 0 } },
    skips: { superseded: 1, expired: 0, permanent: 0, recorded: 1 },
    ignored: emptyIgnored(),
    broadcasts: [],
    sent: 4,
    duplicate: 0,
    failed: 0,
    skipped: 0,
    notConfigured: false,
    timeBudgetExceeded: false,
    results: [{ userId: 'secret-user-id', templateKey: 'registered_1d', result: 'sent' }],
    sample: [{ userId: 'secret-user-id', templateKey: 'registered_1d', dueAt: '2026-10-14T07:00:00.000Z' }],
    ...overrides,
  };
}

type Recorded = {
  runs: LifecycleRunOptions[];
  started: string[];
  finished: Array<Record<string, any>>;
};

function harness(options: { run?: CronDeps['run']; alreadyRunning?: boolean; env?: Record<string, string | undefined> } = {}) {
  const recorded: Recorded = { runs: [], started: [], finished: [] };
  const admin = { marker: 'admin' };
  const deps: CronDeps = {
    createAdmin: () => admin,
    run:
      options.run ??
      (async (runOptions) => {
        recorded.runs.push(runOptions);
        return summary({ dryRun: runOptions.dryRun === true });
      }),
    startJob: (async (_supabase: unknown, name: string) => {
      recorded.started.push(name);
      return { id: 'job-1', startedAt: new Date('2026-10-14T09:00:00Z'), alreadyRunning: options.alreadyRunning === true };
    }) as CronDeps['startJob'],
    finishJob: (async (input: Record<string, any>) => {
      recorded.finished.push(input);
    }) as CronDeps['finishJob'],
    env: options.env ?? { EMAIL_LIFECYCLE_ENABLED: 'true' },
    now: () => new Date('2026-10-14T09:00:00Z'),
  };
  // `run` above records; a custom run still needs to be observable.
  if (options.run) {
    const custom = options.run;
    deps.run = async (runOptions) => {
      recorded.runs.push(runOptions);
      return custom(runOptions);
    };
  }
  return { deps, recorded, admin };
}

async function withSecret<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

// ---------------------------------------------------------------------------
// Authorization and the off switch
// ---------------------------------------------------------------------------

test('401 without the right bearer token, and nothing runs', () =>
  withSecret(async () => {
    for (const authorization of [null, 'Bearer nope', `Bearer ${SECRET}x`, SECRET]) {
      const { deps, recorded } = harness();
      const response = await handleEmailLifecycleCron(request('', authorization), deps);
      assert.equal(response.status, 401, String(authorization));
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
      assert.deepEqual(recorded.runs, []);
      assert.deepEqual(recorded.started, []);
    }
    // A dry run is no exception.
    const { deps, recorded } = harness();
    assert.equal((await handleEmailLifecycleCron(request('?dry=1', 'Bearer nope'), deps)).status, 401);
    assert.deepEqual(recorded.runs, []);
  }));

test('401 when the secret is not configured at all', async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const { deps, recorded } = harness();
    const response = await handleEmailLifecycleCron(request('', 'Bearer undefined'), deps);
    assert.equal(response.status, 401);
    assert.deepEqual(recorded.runs, []);
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous;
  }
});

test('503 disabled unless EMAIL_LIFECYCLE_ENABLED is exactly "true"; no run, no job row', () =>
  withSecret(async () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes', ' true']) {
      const { deps, recorded } = harness({ env: { EMAIL_LIFECYCLE_ENABLED: value } });
      const response = await handleEmailLifecycleCron(request(), deps);
      assert.equal(response.status, 503, String(value));
      assert.deepEqual(await response.json(), { skipped: 'disabled' });
      assert.deepEqual(recorded.runs, []);
      assert.deepEqual(recorded.started, []);
    }
  }));

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('a dry run works while the feature is switched off and never opens a job row', () =>
  withSecret(async () => {
    const { deps, recorded, admin } = harness({ env: {} });
    const response = await handleEmailLifecycleCron(request('?dry=1'), deps);
    assert.equal(response.status, 200);
    const body = (await response.json()) as LifecycleRunSummary;
    assert.equal(body.dryRun, true);
    assert.equal(body.sample.length, 1, 'a dry run shows its sample');

    assert.equal(recorded.runs.length, 1);
    const [options] = recorded.runs;
    assert.equal(options!.dryRun, true);
    assert.equal(options!.admin, admin);
    assert.deepEqual(options!.config, { assumeApproved: false });
    assert.deepEqual(recorded.started, []);
    assert.deepEqual(recorded.finished, []);
  }));

test('dry run preview parameters: activated_at and assume_approved reach the runner', () =>
  withSecret(async () => {
    const { deps, recorded } = harness();
    const query = `?dry=1&assume_approved=1&activated_at=${encodeURIComponent('2026-10-20T00:00:00+03:00')}`;
    const response = await handleEmailLifecycleCron(request(query), deps);
    assert.equal(response.status, 200);
    assert.deepEqual(recorded.runs[0]!.config, { activatedAt: '2026-10-19T21:00:00.000Z', assumeApproved: true });
  }));

test('assume_approved must be exactly 1', () =>
  withSecret(async () => {
    for (const value of ['true', '0', '', 'yes']) {
      const { deps, recorded } = harness();
      await handleEmailLifecycleCron(request(`?dry=1&assume_approved=${value}`), deps);
      assert.equal(recorded.runs[0]!.config!.assumeApproved, false, value);
    }
  }));

test('a dry run with an unreadable activated_at is a 400 and runs nothing', () =>
  withSecret(async () => {
    const { deps, recorded } = harness();
    const response = await handleEmailLifecycleCron(request('?dry=1&activated_at=tomorrow-ish'), deps);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_activated_at' });
    assert.deepEqual(recorded.runs, []);
  }));

test('a dry run that throws is a 500 with a message, not a crash', () =>
  withSecret(async () => {
    const { deps } = harness({
      run: async () => {
        throw new Error('column users.email_prefs does not exist');
      },
    });
    const response = await handleEmailLifecycleCron(request('?dry=1'), deps);
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, 'dry_run_failed');
    assert.match(body.message, /email_prefs/);
  }));

// ---------------------------------------------------------------------------
// A real run
// ---------------------------------------------------------------------------

test('a real run opens a job row, runs once, closes the row and hides the per-user lists', () =>
  withSecret(async () => {
    const { deps, recorded, admin } = harness();
    const response = await handleEmailLifecycleCron(request(), deps);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.sent, 4);
    assert.equal('results' in body, false, 'user ids stay out of the response');
    assert.equal('sample' in body, false);
    assert.doesNotMatch(JSON.stringify(body), /secret-user-id/);

    assert.deepEqual(recorded.started, ['email-lifecycle']);
    assert.equal(recorded.runs.length, 1);
    assert.deepEqual(Object.keys(recorded.runs[0]!).sort(), ['admin', 'now'], 'a real run takes no preview options');
    assert.equal(recorded.runs[0]!.admin, admin);
    assert.equal(recorded.finished.length, 1);
    const finish = recorded.finished[0]!;
    assert.equal(finish.status, 'success');
    assert.equal(finish.processed, 4);
    assert.equal(finish.supabase, admin);
    assert.equal(finish.job.id, 'job-1');
    assert.deepEqual(finish.details, {
      gate: 'open',
      considered: 12,
      planned: 4,
      sent: 4,
      failed: 0,
      skipped: 0,
      duplicate: 0,
      skipsRecorded: 1,
      notConfigured: false,
      timeBudgetExceeded: false,
    });
  }));

test('the preview parameters are ignored on a real run, so they can never cause a send', () =>
  withSecret(async () => {
    const { deps, recorded } = harness();
    await handleEmailLifecycleCron(request(`?assume_approved=1&activated_at=${encodeURIComponent('2020-01-01T00:00:00Z')}`), deps);
    assert.equal(recorded.runs.length, 1);
    assert.equal(recorded.runs[0]!.dryRun, undefined);
    assert.equal(recorded.runs[0]!.config, undefined);
  }));

test('a real run with an unreadable activated_at is not rejected: the parameter does not exist for it', () =>
  withSecret(async () => {
    const { deps, recorded } = harness();
    const response = await handleEmailLifecycleCron(request('?activated_at=garbage'), deps);
    assert.equal(response.status, 200);
    assert.equal(recorded.runs.length, 1);
  }));

test('409 when the previous run is still going; nothing runs', () =>
  withSecret(async () => {
    const { deps, recorded } = harness({ alreadyRunning: true });
    const response = await handleEmailLifecycleCron(request(), deps);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { skipped: 'already_running' });
    assert.deepEqual(recorded.runs, []);
    assert.deepEqual(recorded.finished, []);
  }));

test('the job row says partial when anything went wrong, success otherwise', () =>
  withSecret(async () => {
    const cases: Array<[Partial<LifecycleRunSummary>, string]> = [
      [{}, 'success'],
      [{ skipped: 3, duplicate: 2 }, 'success'],
      [{ failed: 1 }, 'partial'],
      [{ timeBudgetExceeded: true }, 'partial'],
      [{ notConfigured: true }, 'partial'],
    ];
    for (const [overrides, status] of cases) {
      const { deps, recorded } = harness({ run: async () => summary(overrides) });
      const response = await handleEmailLifecycleCron(request(), deps);
      assert.equal(response.status, 200);
      assert.equal(recorded.finished[0]!.status, status, JSON.stringify(overrides));
    }
  }));

test('a run that throws closes the job row as failed and answers 500', () =>
  withSecret(async () => {
    const { deps, recorded } = harness({
      run: async () => {
        throw new Error('could not load users (42703)');
      },
    });
    const response = await handleEmailLifecycleCron(request(), deps);
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, 'email_lifecycle_failed');
    assert.match(body.message, /42703/);
    assert.equal(recorded.finished.length, 1);
    assert.equal(recorded.finished[0]!.status, 'failed');
    assert.equal(recorded.finished[0]!.errors.length, 1);
  }));

test('503 when the service-role client cannot be created', () =>
  withSecret(async () => {
    const { deps, recorded } = harness();
    deps.createAdmin = () => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
    };
    const response = await handleEmailLifecycleCron(request(), deps);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, 'service_role_missing');
    assert.deepEqual(recorded.runs, []);
    assert.deepEqual(recorded.started, []);
  }));

// ---------------------------------------------------------------------------
// The route file and what it replaced
// ---------------------------------------------------------------------------

test('the route is a thin GET with a 120 second budget, and it checks the bearer token', async () => {
  const route = await import('../app/api/cron/email-lifecycle/route');
  assert.equal(route.maxDuration, 120);
  assert.equal(typeof route.GET, 'function');
  const keys = Object.keys(route).sort();
  assert.deepEqual(keys, ['GET', 'maxDuration'], 'a Next route file may only export route fields');

  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  try {
    const response = await route.GET(request('', 'Bearer wrong'));
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('the replaced #84 stage-followups code is gone, the shared stage files remain', () => {
  for (const gone of [
    'app/api/cron/stage-followups/route.ts',
    'config/stage-followups.ts',
    'lib/stages/plan.ts',
    'lib/stages/run-followups.ts',
    'lib/stages/messages.ts',
  ]) {
    assert.equal(existsSync(new URL(`../${gone}`, import.meta.url)), false, gone);
  }
  for (const kept of ['lib/stages/events.ts', 'lib/stages/types.ts', 'lib/stages/funnel.ts', 'lib/stages/load-funnel.ts']) {
    assert.equal(existsSync(new URL(`../${kept}`, import.meta.url)), true, kept);
  }
});

test('the auth callback sends no mail and makes no outbound call, even with the lifecycle on and Resend configured', async () => {
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    outbound.push(String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const previous = { ...process.env };
  Object.assign(process.env, {
    EMAIL_LIFECYCLE_ENABLED: 'true',
    RESEND_API_KEY: 're_test_key',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    UNSUBSCRIBE_SECRET: 'test-secret-value',
  });
  try {
    const exchanged: string[] = [];
    const GET = createOAuthCallbackHandler({
      createSupabase: async () => ({
        auth: {
          exchangeCodeForSession: async (code: string) => {
            exchanged.push(code);
            return { error: null };
          },
        },
      }),
    });

    const ok = await GET(new NextRequest('https://ai.modaafa.com/auth/callback?code=abc&next=/welcome'));
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), 'https://ai.modaafa.com/welcome');
    assert.deepEqual(exchanged, ['abc']);

    // A failed exchange and a missing code go to the login page, still without any mail.
    const failing = createOAuthCallbackHandler({
      createSupabase: async () => ({ auth: { exchangeCodeForSession: async () => ({ error: { message: 'bad code' } }) } }),
    });
    assert.equal((await failing(new NextRequest('https://ai.modaafa.com/auth/callback?code=bad'))).headers.get('location'), 'https://ai.modaafa.com/login?error=auth_callback_failed');
    assert.equal((await GET(new NextRequest('https://ai.modaafa.com/auth/callback'))).headers.get('location'), 'https://ai.modaafa.com/login?error=auth_callback_failed');

    // An off-site `next` is not followed.
    const offsite = await GET(new NextRequest('https://ai.modaafa.com/auth/callback?code=abc&next=//evil.example'));
    assert.equal(new URL(offsite.headers.get('location')!).origin, 'https://ai.modaafa.com');

    assert.deepEqual(outbound, [], 'no request to Resend, Supabase or anything else');
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

const REG_USER = {
  id: '0b3a1d2e-1111-4222-8333-444455556666',
  email: 'a@b.co',
  user_metadata: { full_name: 'أيمن أمين', reg: { phone: '0501234567' } },
};

function registrationDb(resultStatus: string): RegistrationDb {
  return {
    rpc: async (fn) =>
      fn === 'finalize_registration'
        ? { data: [{ result_status: resultStatus, result_registered_at: null }], error: null }
        : { data: null, error: null },
  };
}

async function finishRegistration(resultStatus: string, details?: { name?: string | null; phone?: string | null }, user = REG_USER) {
  const welcomed: string[] = [];
  const outcome = await finalizeForRequest(
    new NextRequest('https://ai.modaafa.com/api/register/complete', { method: 'POST' }),
    user,
    details,
    {
      db: registrationDb(resultStatus),
      sendServerEvent: async () => ({ status: 'sent', testMode: false }),
      sendWelcome: (userId) => welcomed.push(userId),
    }
  );
  return { outcome, welcomed };
}

test('the registration service starts the welcome mail exactly once, only for a completed registration', async () => {
  const completed = await finishRegistration('completed');
  assert.equal(completed.outcome.status, 'completed');
  assert.deepEqual(completed.welcomed, [REG_USER.id]);

  for (const status of ['already', 'phone_taken', 'something_else']) {
    const result = await finishRegistration(status);
    assert.notEqual(result.outcome.status, 'completed', status);
    assert.deepEqual(result.welcomed, [], `${status}: no welcome mail`);
  }

  // Details that do not validate never reach the database and send nothing.
  const needsDetails = await finishRegistration('completed', { phone: 'not a phone' });
  assert.equal(needsDetails.outcome.status, 'needs_details');
  assert.deepEqual(needsDetails.welcomed, []);

  // A database that errors is a failed registration, not a mailed one.
  const welcomed: string[] = [];
  const failed = await finalizeForRequest(
    new NextRequest('https://ai.modaafa.com/api/register/complete', { method: 'POST' }),
    REG_USER,
    undefined,
    {
      db: { rpc: async () => ({ data: null, error: { message: 'boom' } }) },
      sendServerEvent: async () => ({ status: 'sent', testMode: false }),
      sendWelcome: (userId) => welcomed.push(userId),
    }
  );
  assert.equal(failed.status, 'failed');
  assert.deepEqual(welcomed, []);
});

test('the #81 auth trigger is dropped by the lifecycle migration and was never created by the welcome migration', () => {
  // SQL cannot be run here, so this stays a check of the files themselves.
  const welcome = readFileSync(new URL('../db/migrations/20261012_welcome_email.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(welcome, /CREATE\s+TRIGGER\s+on_auth_user_registered/i);
  assert.doesNotMatch(welcome, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.record_registration_completed/i);

  const lifecycle = readFileSync(new URL('../db/migrations/20261014_email_lifecycle.sql', import.meta.url), 'utf8');
  assert.match(lifecycle, /DROP TRIGGER IF EXISTS on_auth_user_registered ON auth\.users/);
  assert.match(lifecycle, /DROP FUNCTION IF EXISTS public\.record_registration_completed\(\)/);
});

test('the new migration is additive, idempotent and keeps the scheduler out of the migration folder', () => {
  const sql = readFileSync(new URL('../db/migrations/20261014_email_lifecycle.sql', import.meta.url), 'utf8');
  for (const column of ['email_prefs', 'email_suppressed_at', 'email_suppressed_reason']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'), column);
  }
  for (const column of ['category', 'copy_key', 'delivered_at', 'opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'click_count']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'), column);
  }
  assert.doesNotMatch(sql, /cron\.schedule/i);
  assert.doesNotMatch(sql, /net\.http_/i);

  const proposal = readFileSync(new URL('../db/proposals/20261014_email_lifecycle_cron.sql', import.meta.url), 'utf8');
  assert.match(proposal, /cron\.schedule\(\s*'modaafa-email-lifecycle'/);
  assert.match(proposal, /cron\.unschedule\('modaafa-stage-followups'\)/);
  assert.match(proposal, /\/api\/cron\/email-lifecycle/);
});

test('.env.example documents both switches, off by default', () => {
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^EMAIL_LIFECYCLE_ENABLED=false$/m);
  assert.match(env, /^RESEND_WEBHOOK_SECRET=/m);
});
