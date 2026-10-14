-- =====================================================================
-- Scheduler for the email lifecycle, 2026-10-14
-- Replaces db/proposals/20261012_stage_followups_cron.sql.
--
-- DO NOT RUN until you are ready to switch the feature on. Order of
-- activation (nothing is sent before step 7):
--   1. run 20261012_welcome_email.sql, 20261013_user_stages.sql and
--      20261014_email_lifecycle.sql
--   2. make sure UNSUBSCRIBE_SECRET (or CRON_SECRET), RESEND_API_KEY and
--      RESEND_WEBHOOK_SECRET are set in Vercel, and the Resend webhook points
--      at /api/webhooks/resend
--   3. read the texts (lib/lifecycle/copy.ts) and set `approved: true` on the
--      copies you accept (and on the broadcast in config/email-broadcasts.ts)
--   4. look at the plan WITHOUT sending, as often as you like:
--        GET https://ai.modaafa.com/api/cron/email-lifecycle?dry=1
--        header  Authorization: Bearer <CRON_SECRET>
--      Before anything is switched on it shows everything as ignored. To preview
--      what a given activation moment would do, add
--        &activated_at=2026-10-20T00:00:00%2B03:00&assume_approved=1
--      (these two only work with dry=1; they cannot cause a send)
--   5. set EMAIL_LIFECYCLE_ACTIVATED_AT in config/email-journeys.ts to the
--      activation moment (ISO, with offset). A step due BEFORE it is never
--      sent, so the existing user base is not mailed retroactively.
--   6. set EMAIL_LIFECYCLE_ENABLED=true in Vercel and redeploy
--   7. nothing to run: the GitHub schedule starts sending on its next run.
--      Optional, only with pg_cron: this file, and db/proposals/20261012_welcome_email_cron.sql (the
--      every-minute safety net for the welcome mail; both are proposals, not
--      migrations, so nothing in db/migrations schedules a job. The welcome
--      sweep obeys steps 3, 5 and 6 as well)
--
-- NOTE (14 Oct 2026): pg_cron is not installed on production (claude/97), so
-- the lifecycle already runs from .github/workflows/scheduled-jobs.yml (job
-- email-lifecycle, twice an hour, harmless while switched off). Use this file
-- only if pg_cron is installed later and you want a steadier schedule; then
-- remove the GitHub job so the two do not both run (it is safe, just wasteful).
--
-- Needs the same Vault secret as 20261005_pg_cron_scheduler.sql
-- ("modaafa_cron_secret"). If you never ran that file, use a GitHub Actions
-- schedule instead; the route is the same.
--
-- Every 10 minutes. The route is safe to call more often than needed: it has an
-- overlap guard, every message is claimed in message_log before it is sent, and
-- a run sends at most 100 mails (40 of them broadcast). Mail goes out only
-- between 09:00 and 22:00 Riyadh time.
--
-- Idempotent. Also removes the schedule of the older stage follow-ups job if
-- it was ever created, so the two never run side by side.
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
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'modaafa-email-lifecycle') THEN
    PERFORM cron.unschedule('modaafa-email-lifecycle');
  END IF;
END;
$$;

SELECT cron.schedule(
  'modaafa-email-lifecycle',
  '*/10 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://ai.modaafa.com/api/cron/email-lifecycle',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'modaafa_cron_secret' LIMIT 1)
      ),
      timeout_milliseconds := 120000
    );
  $job$
);

-- Stop it any time:  select cron.unschedule('modaafa-email-lifecycle');
-- Verify:            select jobname, schedule, active from cron.job where jobname = 'modaafa-email-lifecycle';
