-- Every-minute trigger for the welcome email sweep - 2026-10-12
--
-- PROPOSAL, NOT A MIGRATION. It schedules a job that calls production, so it
-- lives in db/proposals/ and is never run by the migrations folder. Run it by
-- hand, once, at the same moment as db/proposals/20261014_email_lifecycle_cron.sql
-- (step 7 of the activation order in that file), and only if the Vault secret
-- "modaafa_cron_secret" already exists (same prerequisite as
-- 20261005_pg_cron_scheduler.sql). Run AFTER 20261012_welcome_email.sql.
--
-- The sweep is only the safety net: the welcome email normally goes out right
-- after a registration completes (lib/lifecycle/welcome.ts). The GitHub
-- schedule cannot fire every minute, so without this job a welcome that failed
-- to send in that moment would wait for a manual call.
--
-- Scheduling it does not switch anything on. The endpoint does nothing (no
-- read, no write) until EMAIL_LIFECYCLE_ENABLED=true, EMAIL_LIFECYCLE_ACTIVATED_AT
-- (config/email-journeys.ts) has passed and the welcome copy is approved, and it
-- only ever looks at registrations from the activation moment on.
--
-- The endpoint is safe to call as often as you like: message_log has a unique
-- (user, channel, template) row, so a repeat call never sends twice.
--
-- Idempotent: the job is unscheduled first, then recreated.
--
-- Stop it any time:  select cron.unschedule('modaafa-welcome-email');

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'modaafa_cron_secret') then
    raise exception 'Vault secret "modaafa_cron_secret" is missing. See the header of 20261005_pg_cron_scheduler.sql.';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'modaafa-welcome-email') then
    perform cron.unschedule('modaafa-welcome-email');
  end if;
end;
$$;

select cron.schedule(
  'modaafa-welcome-email',
  '* * * * *',
  $job$
    select net.http_get(
      url := 'https://ai.modaafa.com/api/cron/welcome-email',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'modaafa_cron_secret' limit 1)
      ),
      timeout_milliseconds := 50000
    );
  $job$
);

-- Verification (run manually):
--   select jobname, schedule, active from cron.job where jobname = 'modaafa-welcome-email';
--   select status_code, content::text, created from net._http_response order by created desc limit 5;
