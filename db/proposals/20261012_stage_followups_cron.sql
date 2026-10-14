-- =====================================================================
-- SUPERSEDED by 20261014_email_lifecycle_cron.sql. The route this file calls
-- (/api/cron/stage-followups) no longer exists. Do not run this file.
-- =====================================================================
-- Scheduler for the stage follow-up emails, 2026-10-12
--
-- DO NOT RUN until you are ready to switch the feature on. Order of
-- activation (nothing is sent before step 6):
--   1. run 20261012_welcome_email.sql (the immediate-message PR, #81)
--   2. run 20261013_user_stages.sql
--   3. make sure UNSUBSCRIBE_SECRET (or CRON_SECRET) is set in Vercel, and
--      the email provider keys the welcome email already needs
--   4. read the texts (lib/stages/messages.ts) and set `approved: true` on the
--      steps you accept (config/stage-followups.ts)
--   5. set STAGE_FOLLOWUPS_COHORT_START in config/stage-followups.ts to the
--      activation time, so nobody registered before it is ever messaged
--   6. set STAGE_FOLLOWUPS_ENABLED=true in Vercel and redeploy, then run this file
--
-- Check what would be sent without sending anything, at any time:
--   GET https://ai.modaafa.com/api/cron/stage-followups?dry=1
--   with the header  Authorization: Bearer <CRON_SECRET>
--
-- Needs the same Vault secret as 20261005_pg_cron_scheduler.sql
-- ("modaafa_cron_secret"). If you never ran that file, use a GitHub Actions
-- schedule instead; the route is the same.
--
-- Every 5 minutes: the shortest follow-up step is 15 minutes. The route is
-- safe to call more often than needed: it has an overlap guard and every step
-- is sent at most once per person.
--
-- Idempotent.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'modaafa_cron_secret'
  ) THEN
    RAISE EXCEPTION
      'Vault secret "modaafa_cron_secret" is missing. See the header of 20261005_pg_cron_scheduler.sql.';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'modaafa-stage-followups') THEN
    PERFORM cron.unschedule('modaafa-stage-followups');
  END IF;
END;
$$;

SELECT cron.schedule(
  'modaafa-stage-followups',
  '*/5 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://ai.modaafa.com/api/cron/stage-followups',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'modaafa_cron_secret' LIMIT 1)
      ),
      timeout_milliseconds := 120000
    );
  $job$
);

-- Stop it any time:  select cron.unschedule('modaafa-stage-followups');
-- Verify:            select jobname, schedule, active from cron.job where jobname = 'modaafa-stage-followups';
