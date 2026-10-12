-- =====================================================================
-- User stages, user_events and message_log — 2026-10-12
--
-- What this adds
--   1. public.user_events      one row per user per event (first time only)
--   2. users.stage             registered -> connected -> analysis_viewed -> subscribed
--                              (advances only, never goes back)
--   3. users.messages_opt_out  the person asked us to stop sending follow-ups
--   4. public.message_log      every follow-up we tried to send, one row per
--                              (user, template) so a step can never go out twice
--   5. record_user_event()     the ONLY writer of user_events, and the only
--                              thing that moves users.stage
--   6. a trigger that records registration_completed when a users row appears
--   7. a one-time backfill so the /operations/funnel report is truthful for
--      everyone who registered before this migration
--
-- Safe to run more than once. Run it by hand in the Supabase SQL editor; the
-- application code is written to keep working until it has been run (every
-- call into these objects is wrapped and logged, never thrown).
--
-- Follow-up messages are NOT enabled by this file. They need the
-- STAGE_FOLLOWUPS_ENABLED flag, a cohort start date and approved texts (see
-- config/stage-followups.ts).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Stage vocabulary (shared names, do not rename)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stage_rank(p_stage text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_stage
    WHEN 'registered'      THEN 1
    WHEN 'connected'       THEN 2
    WHEN 'analysis_viewed' THEN 3
    WHEN 'subscribed'      THEN 4
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public.stage_for_event(p_event text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_event
    WHEN 'ads_account_connected' THEN 'connected'
    WHEN 'first_analysis_viewed' THEN 'analysis_viewed'
    WHEN 'subscription_paid'     THEN 'subscribed'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------
-- 2. users columns
-- ---------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS messages_opt_out boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_stage_check') THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_stage_check
      CHECK (stage IN ('registered', 'connected', 'analysis_viewed', 'subscribed'));
  END IF;
END $$;

-- A signed-in browser must not be able to move its own stage (the owner RLS
-- policy on users lets a person update their own row). Only the service role
-- and the database owner, which is what record_user_event() runs as, may.
-- messages_opt_out stays editable by the owner on purpose: it is their choice.
CREATE OR REPLACE FUNCTION public.users_guard_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    NEW.stage := OLD.stage;
    NEW.stage_changed_at := OLD.stage_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_guard_stage ON public.users;
CREATE TRIGGER users_guard_stage
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_guard_stage();

-- ---------------------------------------------------------------------
-- 3. user_events
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'registration_completed',
    'welcome_email_sent',
    'onboarding_viewed',
    'connect_clicked',
    'ads_account_connected',
    'first_analysis_viewed',
    'subscription_paid'
  )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- First time only: a repeated event is a no-op, which is what makes every
-- call site safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS user_events_user_event_uidx
  ON public.user_events (user_id, event_type);
CREATE INDEX IF NOT EXISTS user_events_type_time_idx
  ON public.user_events (event_type, occurred_at);

ALTER TABLE public.user_events ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role (which bypasses RLS) reads
-- or writes this table.
REVOKE ALL ON public.user_events FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. record_user_event(): write the event and advance the stage
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_user_event(
  p_user_id uuid,
  p_event_type text,
  p_occurred_at timestamptz DEFAULT now(),
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer := 0;
  v_stage text;
BEGIN
  INSERT INTO public.user_events (user_id, event_type, occurred_at, metadata)
  VALUES (p_user_id, p_event_type, COALESCE(p_occurred_at, now()), COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (user_id, event_type) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  v_stage := public.stage_for_event(p_event_type);
  IF v_stage IS NOT NULL THEN
    -- Runs even when the event row already existed, so a user whose stage
    -- was left behind by an earlier failure is healed by the next call.
    -- The rank comparison is what makes the stage advance-only.
    UPDATE public.users
       SET stage = v_stage,
           stage_changed_at = COALESCE(p_occurred_at, now())
     WHERE id = p_user_id
       AND public.stage_rank(stage) < public.stage_rank(v_stage);
  END IF;

  RETURN v_rows > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_user_event(uuid, text, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_event(uuid, text, timestamptz, jsonb)
  TO service_role;

-- ---------------------------------------------------------------------
-- 5. registration_completed, recorded wherever a users row is created
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.users_record_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_events (user_id, event_type, occurred_at)
  VALUES (NEW.id, 'registration_completed', COALESCE(NEW.created_at, now()))
  ON CONFLICT (user_id, event_type) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_record_registration ON public.users;
CREATE TRIGGER users_record_registration
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_record_registration();

-- ---------------------------------------------------------------------
-- 6. message_log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  template_key text NOT NULL,
  stage text,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  reason text,
  provider_id text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- One row per (user, template): a follow-up step can never be sent twice,
-- even if two cron invocations overlap.
CREATE UNIQUE INDEX IF NOT EXISTS message_log_user_template_uidx
  ON public.message_log (user_id, template_key);
CREATE INDEX IF NOT EXISTS message_log_user_sent_idx
  ON public.message_log (user_id, sent_at DESC) WHERE status = 'sent';

ALTER TABLE public.message_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_log FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. One-time backfill (everyone who registered before today)
--
-- Backfilled rows carry metadata.backfilled = true. They exist only so the
-- report is truthful about history; the follow-up scheduler ignores anyone who
-- registered before the cohort start date, so none of this sends anything.
-- first_analysis_viewed is approximated from "an audit exists", because the
-- real "opened the result" moment was not recorded before this migration.
-- ---------------------------------------------------------------------
INSERT INTO public.user_events (user_id, event_type, occurred_at, metadata)
SELECT u.id, 'registration_completed', COALESCE(u.created_at, now()), '{"backfilled":true}'::jsonb
  FROM public.users u
ON CONFLICT (user_id, event_type) DO NOTHING;

INSERT INTO public.user_events (user_id, event_type, occurred_at, metadata)
SELECT b.user_id, 'ads_account_connected', MIN(g.linked_at), '{"backfilled":true}'::jsonb
  FROM public.google_ads_accounts g
  JOIN public.businesses b ON b.id = g.business_id
 WHERE g.is_manager IS NOT TRUE
   AND g.linked_at IS NOT NULL
 GROUP BY b.user_id
ON CONFLICT (user_id, event_type) DO NOTHING;

INSERT INTO public.user_events (user_id, event_type, occurred_at, metadata)
SELECT b.user_id, 'first_analysis_viewed', MIN(a.ran_at),
       '{"backfilled":true,"proxy":"audit_exists"}'::jsonb
  FROM public.audits a
  JOIN public.google_ads_accounts g ON g.id = a.account_id
  JOIN public.businesses b ON b.id = g.business_id
 WHERE a.ran_at IS NOT NULL
 GROUP BY b.user_id
ON CONFLICT (user_id, event_type) DO NOTHING;

INSERT INTO public.user_events (user_id, event_type, occurred_at, metadata)
SELECT i.user_id, 'subscription_paid', MIN(COALESCE(i.paid_at, i.created_at)),
       '{"backfilled":true}'::jsonb
  FROM public.invoices i
 WHERE i.status = 'paid'
   AND i.amount_sar > 0
 GROUP BY i.user_id
ON CONFLICT (user_id, event_type) DO NOTHING;

-- Bring users.stage in line with the events (advance only).
UPDATE public.users u
   SET stage = s.stage,
       stage_changed_at = s.at
  FROM (
    SELECT e.user_id,
           public.stage_for_event(e.event_type) AS stage,
           e.occurred_at AS at,
           public.stage_rank(public.stage_for_event(e.event_type)) AS rank,
           ROW_NUMBER() OVER (
             PARTITION BY e.user_id
             ORDER BY public.stage_rank(public.stage_for_event(e.event_type)) DESC
           ) AS rn
      FROM public.user_events e
     WHERE public.stage_for_event(e.event_type) IS NOT NULL
  ) s
 WHERE s.rn = 1
   AND u.id = s.user_id
   AND public.stage_rank(u.stage) < s.rank;

-- Verification (run manually):
--   -- users per current stage
--   select stage, count(*) from public.users group by stage order by 1;
--   -- must return no rows: a user without a registration event
--   select u.id from public.users u
--    where not exists (select 1 from public.user_events e
--                       where e.user_id = u.id and e.event_type = 'registration_completed');
--   -- must return no rows: a stage that is behind the user's own events
--   select u.id from public.users u
--    where public.stage_rank(u.stage) < coalesce((
--      select max(public.stage_rank(public.stage_for_event(e.event_type)))
--        from public.user_events e where e.user_id = u.id), 0);
