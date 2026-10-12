-- Every-minute trigger for the welcome email sweep - 2026-10-12
--
-- Run AFTER 20261012_welcome_email.sql and ONLY if the Vault secret
-- "modaafa_cron_secret" already exists (same prerequisite as
-- 20261005_pg_cron_scheduler.sql). The GitHub schedule cannot fire every
-- minute, so without this job the email still goes out through the Google
-- sign-in hook but a plain email sign-up would wait for a manual call.
--
-- The endpoint is safe to call as often as you like: message_log has a unique
-- (user, channel, template) row, so a repeat call never sends twice.
--
-- Idempotent: the job is unscheduled first, then recreated.

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
