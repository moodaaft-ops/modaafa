-- PROPOSAL ONLY — DO NOT MOVE TO db/migrations UNTIL THE OWNER APPROVES.
--
-- Preconditions:
--   1. A verified backup of public.pending_oauth_sessions exists.
--   2. The application no longer reads or writes this table.
--   3. scripts/reencrypt-refresh-tokens.ts and db/schema.sql are updated in
--      the same release so a fresh installation does not recreate it.

DO $$
BEGIN
  IF to_regclass('public.pending_oauth_sessions') IS NULL THEN
    RAISE NOTICE 'pending_oauth_sessions is already absent';
    RETURN;
  END IF;

  RAISE NOTICE 'pending_oauth_sessions rows before drop: %',
    (SELECT COUNT(*) FROM public.pending_oauth_sessions);
END $$;

DROP TABLE IF EXISTS public.pending_oauth_sessions CASCADE;

