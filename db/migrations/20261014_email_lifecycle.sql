-- =====================================================================
-- Email lifecycle: preferences, suppression and engagement tracking - 2026-10-14
--
-- RUN AFTER 20261012_welcome_email.sql (user_events, message_log,
-- users.messages_opt_out) and 20261013_user_stages.sql (users.stage). Nothing
-- here sends an email or schedules anything: the cron is a separate, manual
-- step (db/proposals/20261014_email_lifecycle_cron.sql).
--
--   1. users.email_prefs              per-category opt-out; a missing key means "on"
--   2. users.email_suppressed_at      hard bounce or complaint: nothing at all is
--      users.email_suppressed_reason  sent to the address after that
--   3. message_log engagement columns category, copy_key and the delivery /
--                                     open / click / bounce / complaint times
--   4. indexes the webhook and the funnel report read through
--   5. drops the auth.users trigger from the first version of the welcome
--      email (registration_completed is written only by finalize_registration)
--
-- Privileges: same posture as the welcome-email file. users already has
-- INSERT/UPDATE/DELETE revoked from anon and authenticated (a signed-in browser
-- cannot write these columns); message_log is service_role only. New columns
-- inherit both, so no grants change here.
--
-- Idempotent and additive: safe to run twice. Existing message_log rows keep
-- category NULL, which the planner treats as optional mail (all of it was).
-- =====================================================================

DO $$
BEGIN
  IF to_regclass('public.message_log') IS NULL OR to_regclass('public.user_events') IS NULL THEN
    RAISE EXCEPTION
      'public.message_log / public.user_events are missing. Run 20261012_welcome_email.sql first.';
  END IF;
END $$;

-- 1 + 2. Preferences and suppression ------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS email_suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_suppressed_reason text;

-- 3. Engagement tracking on message_log ----------------------------------
ALTER TABLE public.message_log
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS copy_key text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS complained_at timestamptz,
  ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0;

-- 4. Indexes --------------------------------------------------------------
-- The Resend webhook finds the row by the provider's email id.
CREATE INDEX IF NOT EXISTS message_log_provider_id_idx
  ON public.message_log (provider_id);
-- The funnel report groups by template and sent time; the planner reads the
-- last 7 days of sent rows.
CREATE INDEX IF NOT EXISTS message_log_template_sent_idx
  ON public.message_log (template, sent_at);

-- 5. Drop the first welcome-email trigger -----------------------------------
-- It wrote registration_completed when an address was confirmed, which for a
-- Google user is BEFORE the registration form (phone) is done. The event is now
-- written only by public.finalize_registration(). It was never applied anywhere
-- except possibly a scratch database, hence IF EXISTS.
DROP TRIGGER IF EXISTS on_auth_user_registered ON auth.users;
DROP FUNCTION IF EXISTS public.record_registration_completed();

-- Verification (run manually after applying):
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'users'
--      and column_name in ('email_prefs', 'email_suppressed_at', 'email_suppressed_reason');   -- 3 rows
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'message_log'
--      and column_name in ('category', 'copy_key', 'delivered_at', 'opened_at', 'clicked_at',
--                          'bounced_at', 'complained_at', 'click_count');                       -- 8 rows
--   select count(*) from pg_trigger where tgname = 'on_auth_user_registered';                  -- 0
