-- =====================================================================
-- User stages on top of the welcome-email tables — 2026-10-12
--
-- RUN AFTER 20261012_welcome_email.sql (PR #81). That file creates
-- public.user_events, public.message_log, users.messages_opt_out and the
-- registration_completed trigger. This one only adds what the stages need:
--
--   1. users.stage / users.stage_changed_at
--        registered -> connected -> analysis_viewed -> subscribed
--        advances only, never goes back
--   2. "first time only" for the remaining events (PR #81 only enforced it for
--      registration_completed and welcome_email_sent)
--   3. record_user_event(): the one function the app calls to write an event
--      and move the stage
--   4. a one-time backfill of the three stage events for people who were
--      already connected / analysed / paying, so the report is truthful.
--      registration_completed is deliberately NOT backfilled (see PR #81:
--      people who registered before it must not receive a welcome email, and
--      the follow-up scheduler also keys on that event).
--
-- Safe to run more than once. Run it by hand in the Supabase SQL editor.
-- The application code keeps working before this is run: every call into
-- these objects is wrapped and logged, never thrown.
--
-- Follow-up messages are NOT enabled by this file (see config/stage-followups.ts).
-- =====================================================================

DO $$
BEGIN
  IF to_regclass('public.user_events') IS NULL OR to_regclass('public.message_log') IS NULL THEN
    RAISE EXCEPTION
      'public.user_events / public.message_log are missing. Run 20261012_welcome_email.sql first.';
  END IF;
END $$;

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
-- 2. users.stage
-- ---------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_stage_check') THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_stage_check
      CHECK (stage IN ('registered', 'connected', 'analysis_viewed', 'subscribed'));
  END IF;
END $$;

-- The owner RLS policy on users lets a signed-in browser update its own row,
-- so the stage needs its own guard. Only the service role and the database
-- owner (which is what record_user_event() runs as) may move it.
-- messages_opt_out is untouched on purpose: it is the person's own choice.
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
-- 3. First time only, for every event
-- ---------------------------------------------------------------------
-- PR #81 already has this for registration_completed and welcome_email_sent;
-- the welcome-first-login branch adds it for onboarding_viewed. This covers
-- the rest, so a retried webhook or a refreshed page cannot write a second row.
-- (A duplicate onboarding_viewed index is harmless: a second unique index.)
CREATE UNIQUE INDEX IF NOT EXISTS user_events_once_per_user_stage
  ON public.user_events (user_id, event)
  WHERE event IN (
    'onboarding_viewed',
    'connect_clicked',
    'ads_account_connected',
    'first_analysis_viewed',
    'subscription_paid'
  );

-- ---------------------------------------------------------------------
-- 4. record_user_event(): write the event and advance the stage
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_user_event(
  p_user_id uuid,
  p_event text,
  p_occurred_at timestamptz DEFAULT now(),
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer := 0;
  v_target text := public.stage_for_event(p_event);
  v_row_stage text;
BEGIN
  -- user_events.stage is "the stage the user was in when it happened": the
  -- new stage for a stage-moving event, the current one for the rest.
  v_row_stage := COALESCE(
    v_target,
    (SELECT stage FROM public.users WHERE id = p_user_id),
    'registered'
  );

  INSERT INTO public.user_events (user_id, event, stage, metadata, created_at)
  VALUES (p_user_id, p_event, v_row_stage, COALESCE(p_metadata, '{}'::jsonb), COALESCE(p_occurred_at, now()))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_target IS NOT NULL THEN
    -- Runs even when the event row already existed, so a user whose stage was
    -- left behind by an earlier failure is healed by the next call. The rank
    -- comparison is what makes the stage advance-only.
    UPDATE public.users
       SET stage = v_target,
           stage_changed_at = COALESCE(p_occurred_at, now())
     WHERE id = p_user_id
       AND public.stage_rank(stage) < public.stage_rank(v_target);
  END IF;

  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.record_user_event(uuid, text, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_user_event(uuid, text, timestamptz, jsonb)
  TO service_role;

-- ---------------------------------------------------------------------
-- 5. One-time backfill of the stage events (history only, sends nothing)
--
-- metadata.backfilled = true marks these rows. first_analysis_viewed is
-- approximated from "an audit exists", because the real "opened the result"
-- moment was not recorded before this migration.
-- ---------------------------------------------------------------------
INSERT INTO public.user_events (user_id, event, stage, metadata, created_at)
SELECT b.user_id, 'ads_account_connected', 'connected', '{"backfilled":true}'::jsonb, MIN(g.linked_at)
  FROM public.google_ads_accounts g
  JOIN public.businesses b ON b.id = g.business_id
 WHERE g.is_manager IS NOT TRUE
   AND g.linked_at IS NOT NULL
 GROUP BY b.user_id
ON CONFLICT DO NOTHING;

INSERT INTO public.user_events (user_id, event, stage, metadata, created_at)
SELECT b.user_id, 'first_analysis_viewed', 'analysis_viewed',
       '{"backfilled":true,"proxy":"audit_exists"}'::jsonb, MIN(a.ran_at)
  FROM public.audits a
  JOIN public.google_ads_accounts g ON g.id = a.account_id
  JOIN public.businesses b ON b.id = g.business_id
 WHERE a.ran_at IS NOT NULL
 GROUP BY b.user_id
ON CONFLICT DO NOTHING;

INSERT INTO public.user_events (user_id, event, stage, metadata, created_at)
SELECT i.user_id, 'subscription_paid', 'subscribed', '{"backfilled":true}'::jsonb,
       MIN(COALESCE(i.paid_at, i.created_at))
  FROM public.invoices i
 WHERE i.status = 'paid'
   AND i.amount_sar > 0
 GROUP BY i.user_id
ON CONFLICT DO NOTHING;

-- Bring users.stage in line with the events (advance only).
UPDATE public.users u
   SET stage = s.stage,
       stage_changed_at = s.at
  FROM (
    SELECT e.user_id,
           public.stage_for_event(e.event) AS stage,
           e.created_at AS at,
           public.stage_rank(public.stage_for_event(e.event)) AS rank,
           ROW_NUMBER() OVER (
             PARTITION BY e.user_id
             ORDER BY public.stage_rank(public.stage_for_event(e.event)) DESC
           ) AS rn
      FROM public.user_events e
     WHERE public.stage_for_event(e.event) IS NOT NULL
  ) s
 WHERE s.rn = 1
   AND u.id = s.user_id
   AND public.stage_rank(u.stage) < s.rank;

-- If the registration-before-value migration ran first, its grandfathered
-- users have registered_at set and stage NULL ("the stage work owns
-- back-filling it"). They are registered people, so they get 'registered'.
-- People still mid-registration (registered_at NULL) keep a NULL stage.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'registered_at'
  ) THEN
    EXECUTE 'UPDATE public.users SET stage = ''registered'' WHERE stage IS NULL AND registered_at IS NOT NULL';
  END IF;
END;
$$;

-- Verification (run manually):
--   -- users per current stage
--   select stage, count(*) from public.users group by stage order by 1;
--   -- must return no rows: a stage that is behind the user's own events
--   select u.id from public.users u
--    where public.stage_rank(u.stage) < coalesce((
--      select max(public.stage_rank(public.stage_for_event(e.event)))
--        from public.user_events e where e.user_id = u.id), 0);
