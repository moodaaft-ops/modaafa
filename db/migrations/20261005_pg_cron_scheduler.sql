-- =====================================================================
-- In-database scheduler for the hourly crons — 2026-10-05
--
-- OPTIONAL. Only needed if GitHub keeps dropping scheduled runs even with the
-- multi-slot schedule in .github/workflows/scheduled-jobs.yml. It also needs
-- the CRON_SECRET stored in Supabase Vault (see below). Safe to skip.
--
-- Why: the GitHub Actions schedule in .github/workflows/scheduled-jobs.yml is
-- best-effort and was observed dropping most hourly runs (job_runs shows only
-- 2-6 sync and 2-6 optimize runs a day instead of 24). pg_cron fires on time.
--
-- BEFORE running this file, create the secret ONCE in the Supabase SQL editor
-- (same value as the CRON_SECRET env var in Vercel / the GitHub secret). Never
-- commit the real value:
--
--   select vault.create_secret('<PASTE-CRON_SECRET-HERE>', 'modaafa_cron_secret',
--                              'Bearer token for ai.modaafa.com cron endpoints');
--   -- rotate later with: select vault.update_secret(
--   --   (select id from vault.secrets where name = 'modaafa_cron_secret'),
--   --   '<NEW-VALUE>');
--
-- Auth contract (lib/security/cron-auth.ts): the endpoints require the exact
-- header  Authorization: Bearer <CRON_SECRET>  — the same header the GitHub
-- workflow sends with `curl -H "Authorization: Bearer $CRON_SECRET"` (GET).
--
-- Overlap with the GitHub schedule: it can stay as a backup. Both endpoints
-- call startJobRun() first (lib/platform/jobs.ts), which refuses a second run
-- while a `running` job_runs row younger than 10 minutes exists (HTTP 409
-- {"skipped":"already_running"}), and the partial unique index
-- job_runs_one_running_per_job (migration 20260803_full_audit_integrity.sql)
-- closes the check-then-insert race. So two simultaneous triggers cannot
-- process the same accounts twice. Caveats: a trigger that arrives AFTER the
-- first run finished is a normal second run (extra Anthropic spend for
-- optimize), and the workflow's `curl --fail` turns a 409 into a red GitHub
-- run. Once this scheduler is verified, disabling the GitHub schedule is the
-- cleaner setup.
--
-- Idempotent: safe to re-run (jobs are unscheduled first, then recreated).
-- =====================================================================

-- Extensions (Supabase ships all three; this only enables them).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  CREATE EXTENSION IF NOT EXISTS pg_net;
  CREATE EXTENSION IF NOT EXISTS supabase_vault;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION
    'Could not enable pg_cron / pg_net / supabase_vault (%). Enable them under Database > Extensions, then re-run.',
    SQLERRM;
END;
$$;

-- Refuse to schedule jobs that would send an empty bearer token.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'modaafa_cron_secret'
  ) THEN
    RAISE EXCEPTION
      'Vault secret "modaafa_cron_secret" is missing. Create it first with vault.create_secret (see the header of this file).';
  END IF;
END;
$$;

-- Unschedule previous versions (idempotency).
DO $$
DECLARE
  existing TEXT;
BEGIN
  FOREACH existing IN ARRAY ARRAY['modaafa-sync', 'modaafa-optimize'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = existing) THEN
      PERFORM cron.unschedule(existing);
    END IF;
  END LOOP;
END;
$$;

-- Hourly Google Ads sync at minute 17 (same minute as the GitHub workflow).
SELECT cron.schedule(
  'modaafa-sync',
  '17 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://ai.modaafa.com/api/cron/sync-google-ads',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'modaafa_cron_secret' LIMIT 1)
      ),
      timeout_milliseconds := 300000
    );
  $job$
);

-- Hourly optimization analysis at minute 47 (same minute as the GitHub workflow).
SELECT cron.schedule(
  'modaafa-optimize',
  '47 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://ai.modaafa.com/api/cron/optimize',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'modaafa_cron_secret' LIMIT 1)
      ),
      timeout_milliseconds := 300000
    );
  $job$
);

-- Verification (run manually):
--   select jobname, schedule, active from cron.job where jobname like 'modaafa-%';
--   select status, started_at from job_runs order by started_at desc limit 10;
--   select id, status_code, content::text, created
--     from net._http_response order by created desc limit 5;  -- expect 200
