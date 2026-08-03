-- =============================================================================
-- 2026-08-03 — Full-audit integrity hardening
--
-- Forward-only and safe to run repeatedly. Apply via Supabase SQL Editor or
-- `pnpm db:migrate`. Nothing here deletes user data; every destructive-looking
-- statement below only merges duplicates or retires corpse rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) job_runs: at most ONE live run per job.
--
-- The GitHub Actions scheduler calls the cron routes with
-- `--retry 2 --retry-all-errors --max-time 290` against maxDuration=300, so a
-- slow invocation is aborted client-side and re-invoked while the first is
-- still executing. The app now refuses overlap (lib/platform/jobs.ts), but its
-- check-then-insert has a narrow race; this index closes it at the database.
-- First retire any stale `running` corpses so the index can build.
-- -----------------------------------------------------------------------------
UPDATE job_runs
SET status = 'failed',
    finished_at = NOW(),
    error_message = COALESCE(error_message, 'superseded: running row went stale before 20260803 migration')
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';

-- If two FRESH running rows exist for one job (the exact race this fixes),
-- keep the newest and retire the rest.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
  FROM job_runs
  WHERE status = 'running'
)
UPDATE job_runs
SET status = 'failed',
    finished_at = NOW(),
    error_message = 'superseded: duplicate concurrent running row merged by 20260803 migration'
FROM ranked
WHERE job_runs.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS job_runs_one_running_per_job
  ON job_runs (job_name)
  WHERE status = 'running';

-- -----------------------------------------------------------------------------
-- 2) reports: one weekly performance report per account per week.
--
-- The weekly-report writer is read-check-then-insert with no unique backstop,
-- so two overlapping optimize runs could write two reports for the same week.
-- Merge any existing duplicates (keep the newest), then add the backstop. The
-- app tolerates 23505 on this insert.
-- -----------------------------------------------------------------------------
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY account_id, period_type, period_start
           ORDER BY generated_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM reports
  WHERE period_start IS NOT NULL
)
DELETE FROM reports
USING ranked
WHERE reports.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS reports_account_period_uniq
  ON reports (account_id, period_type, period_start)
  WHERE period_start IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3) usage_events: metering rows are created through consume_feature_usage()
--    ONLY (SECURITY DEFINER), as the schema comment already promises.
--
-- The leftover direct INSERT grant + policy let any signed-in browser insert
-- arbitrary (including backdated) metering rows into its own quota window —
-- self-scoped, but it falsifies usage analytics and contradicts the invariant.
-- The definer function runs as the table owner and does not need the grant.
-- -----------------------------------------------------------------------------
REVOKE INSERT ON usage_events FROM anon, authenticated;
DROP POLICY IF EXISTS usage_events_owner_insert ON usage_events;

-- -----------------------------------------------------------------------------
-- 4) subscriptions: at most one LIVE subscription row per user.
--
-- The app-level guard (`already_subscribed`) is check-then-act: two tabs
-- choosing DIFFERENT plans pass it simultaneously, produce different
-- idempotency keys, and can end as two live Stripe subscriptions and a double
-- charge. Conditional: if live duplicates already exist in this database, the
-- index is skipped with a warning naming the users — resolving which
-- subscription to cancel belongs in Stripe, not in a blind migration.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  conflicting_users INTEGER;
BEGIN
  SELECT COUNT(*) INTO conflicting_users
  FROM (
    SELECT user_id
    FROM subscriptions
    WHERE status IN ('trialing', 'active', 'past_due', 'paused')
    GROUP BY user_id
    HAVING COUNT(*) > 1
  ) AS duplicated;

  IF conflicting_users > 0 THEN
    RAISE WARNING
      'subscriptions_one_live_per_user NOT created: % user(s) hold multiple live subscription rows. Cancel the duplicates in Stripe, let the webhook settle, then re-run this migration.',
      conflicting_users;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_user
      ON subscriptions (user_id)
      WHERE status IN ('trialing', 'active', 'past_due', 'paused');
  END IF;
END $$;
