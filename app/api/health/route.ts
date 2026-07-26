import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getPlatformReadiness, readinessSummary } from '@/lib/platform/readiness';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { isConfiguredEnv } from '@/lib/platform/env';
import { checkStripeConfiguration } from '@/lib/billing/stripe';
import { checkAIConfiguration } from '@/lib/ai/client';

const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_APP_URL',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_MCC_CUSTOMER_ID',
  'ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_YEARLY',
  'STRIPE_PRICE_GROWTH_MONTHLY',
  'STRIPE_PRICE_GROWTH_YEARLY',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_YEARLY',
  'ANTHROPIC_API_KEY',
  'CRON_SECRET',
] as const;

export async function GET(req: NextRequest) {
  const authorized = hasValidCronAuthorization(req);

  if (!authorized) {
    return NextResponse.json({
      ok: true,
      service: 'modaafa',
      timestamp: new Date().toISOString(),
    });
  }

  const env = Object.fromEntries(REQUIRED_ENV.map((key) => [key, isConfiguredEnv(process.env[key])]));
  const readiness = getPlatformReadiness();
  const database = await checkDatabase();
  const [operationalEmail, billing, ai] = await Promise.all([
    checkOperationalEmail(),
    checkStripeConfiguration(),
    checkAIConfiguration(),
  ]);
  const summary = readinessSummary(readiness);
  const envOk = Object.values(env).every(Boolean);
  const ok = envOk && database.ok;
  const launchReady =
    ok &&
    summary.ok &&
    billing.ok &&
    ai.ok &&
    operationalEmail.ok &&
    database.operational_jobs.ok;

  return NextResponse.json({
    ok,
    launch_ready: launchReady,
    service: 'modaafa',
    timestamp: new Date().toISOString(),
    checks: {
      env,
      readiness,
      readiness_summary: summary,
      database,
      billing,
      ai,
      operational_email: operationalEmail,
      google_ads_api_version: process.env.GOOGLE_ADS_API_VERSION ?? 'v22',
    },
  }, { status: ok ? 200 : 503 });
}

async function checkOperationalEmail() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const alertEmail = process.env.OPS_ALERT_EMAIL;

  if (!isConfiguredEnv(apiKey)) {
    return { ok: false, configured: false, domain: null, status: 'api_key_missing' };
  }

  try {
    const response = await fetch('https://api.resend.com/domains', {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    });
    const payload = await response.json() as {
      data?: Array<{ name?: string; status?: string; region?: string }>;
      message?: string;
    };
    const domain = payload.data?.find((item) => item.name === 'modaafa.com') ?? null;
    const configured = isConfiguredEnv(fromEmail) && isConfiguredEnv(alertEmail);

    return {
      ok: response.ok && configured && domain?.status === 'verified',
      configured,
      domain: domain?.name ?? null,
      status: domain?.status ?? (response.ok ? 'domain_missing' : 'api_error'),
      region: domain?.region ?? null,
      error: response.ok ? null : payload.message ?? `Resend HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      configured: isConfiguredEnv(fromEmail) && isConfiguredEnv(alertEmail),
      domain: null,
      status: 'request_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDatabase() {
  try {
    const supabase = createAdminClient();
    const tables = [
      { table: 'businesses', column: 'id' },
      { table: 'google_ads_accounts', column: 'id' },
      { table: 'pending_oauth_sessions', column: 'id' },
      { table: 'oauth_states', column: 'id' },
      { table: 'usage_events', column: 'id' },
      { table: 'job_runs', column: 'id' },
      { table: 'processed_webhook_events', column: 'event_id' },
      { table: 'billing_trial_grants', column: 'user_id' },
      { table: 'rate_limit_windows', column: 'key' },
    ];
    const checks = await Promise.all(
      tables.map(async ({ table, column }) => {
        const { error } = await supabase.from(table).select(column, { count: 'exact', head: true });
        return { table, ok: !error, error: error?.message ?? null };
      })
    );
    const { data: latestJobs, error: jobsError } = await supabase
      .from('job_runs')
      .select('job_name, status, started_at, finished_at, processed, error_count')
      .order('started_at', { ascending: false })
      .limit(10);
    const jobExpectations = [
      { jobName: 'sync-google-ads', maxAgeHours: 30 },
      { jobName: 'optimize', maxAgeHours: 30 },
    ];
    const operationalJobs = jobExpectations.map(({ jobName, maxAgeHours }) => {
      const latest = (latestJobs ?? []).find((job) => job.job_name === jobName) ?? null;
      const ageHours = latest
        ? Math.round(((Date.now() - new Date(latest.started_at).getTime()) / 3_600_000) * 10) / 10
        : null;
      return {
        job_name: jobName,
        ok:
          Boolean(latest) &&
          latest?.status !== 'failed' &&
          ageHours !== null &&
          ageHours <= maxAgeHours,
        latest_status: latest?.status ?? 'missing',
        age_hours: ageHours,
        max_age_hours: maxAgeHours,
      };
    });
    return {
      ok: checks.every((check) => check.ok) && !jobsError,
      checks,
      latest_jobs: latestJobs ?? [],
      operational_jobs: {
        ok: !jobsError && operationalJobs.every((job) => job.ok),
        checks: operationalJobs,
      },
      jobs_error: jobsError?.message ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      operational_jobs: { ok: false, checks: [] },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
