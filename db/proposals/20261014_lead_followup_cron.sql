-- Five-minute trigger for the exit-popup lead follow-up sweep - 2026-10-14
--
-- PROPOSAL, not a migration: run it only after 20261014_visitor_leads.sql and
-- only if the Vault secret "modaafa_cron_secret" already exists (same
-- prerequisite as 20261005_pg_cron_scheduler.sql). The visitor's own request
-- already tries to send the email at once; this job only catches leads where
-- that attempt could not run, for example while the email text was still
-- waiting for approval (config/lead-followup.ts, approved: false).
--
-- The endpoint is safe to call as often as you like: claim_lead_followup is one
-- atomic UPDATE, so a repeat call never emails the same lead twice.
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
  if exists (select 1 from cron.job where jobname = 'modaafa-lead-followups') then
    perform cron.unschedule('modaafa-lead-followups');
  end if;
end;
$$;

select cron.schedule(
  'modaafa-lead-followups',
  '*/5 * * * *',
  $job$
    select net.http_get(
      url := 'https://ai.modaafa.com/api/cron/lead-followups',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'modaafa_cron_secret' limit 1)
      ),
      timeout_milliseconds := 50000
    );
  $job$
);

-- Retention: a visitor who never became a user keeps no contact details for
-- more than 90 days. Optional, remove this block if you prefer to keep them.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'modaafa-lead-retention') then
    perform cron.unschedule('modaafa-lead-retention');
  end if;
end;
$$;

select cron.schedule(
  'modaafa-lead-retention',
  '17 3 * * *',
  $job$ delete from public.visitor_leads where created_at < now() - interval '90 days'; $job$
);

-- Verification (run manually):
--   select jobname, schedule, active from cron.job where jobname = 'modaafa-lead-followups';
--   select status_code, content::text, created from net._http_response order by created desc limit 5;
