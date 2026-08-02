-- =====================================================================
-- Security hardening — 2026-07-30
--
-- RLS decides WHICH ROWS a browser client may touch; these REVOKEs decide
-- WHICH COLUMNS/VERBS. Supabase grants ALL on public tables to
-- anon/authenticated by default, and several tables were left `FOR ALL`
-- with only DELETE revoked — enough to forge security-critical state
-- through PostgREST even though the app never writes it that way.
--
-- 1. users.email is client-writable. It keys the durable trial ledger and
--    addresses transactional mail, so a user could (a) delete-and-
--    re-register for unlimited free trials by recording the ledger under a
--    throwaway address, and (b) point Modaafa's signed mail at a third party.
-- 2. Deleting a google_ads_accounts row through PostgREST discards the only
--    copy of refresh_token_encrypted, stranding a live offline-access Google
--    grant that can then never be revoked — the exact outcome the account
--    deletion flow treats as blocking. Flipping `status` or swapping
--    refresh_token_encrypted are the other dangerous writes.
-- 3. recommendations.action_payload and ai_actions.rollback_payload are
--    executed by trusted server routes as live Google Ads mutations. Browser
--    writes to either table would let a user forge executable state and skip
--    the approval/guardrail state machine. Audit/report rows are also
--    server-generated evidence and must not be forgeable by browser clients.
-- 4. ai_actions.rollback_payload is executed VERBATIM by /api/actions/rollback
--    as a live Google Ads mutation. A client that can INSERT/UPDATE this table
--    can forge an unbounded budget/bid change that bypasses every guardrail,
--    the execution quota, and the subscription check. All writes now go
--    through the service role behind the recommendation/rollback routes.
-- 5. pending_oauth_sessions is currently unused but may still contain
--    encrypted refresh tokens. Removing it is an irreversible operation that
--    requires a confirmed backup and a separate owner-approved migration.
--
-- Forward-only. Safe to re-run.
-- =====================================================================

-- 1) User identity/profile writes are server-owned. A column-level REVOKE does
--    not override Supabase's default table-level UPDATE grant, so revoke the
--    table verbs completely. The auth trigger and service role are unaffected.
REVOKE INSERT, UPDATE, DELETE ON public.users FROM anon, authenticated;

-- 2) Remove the default table-level verbs first, then grant only the metadata
--    columns that authenticated, RLS-scoped server routes need to maintain.
--    INSERT, DELETE, tenant ownership, OAuth credentials and link status remain
--    service-role-only.
REVOKE INSERT, UPDATE, DELETE ON public.google_ads_accounts FROM anon, authenticated;
GRANT UPDATE (
  customer_name,
  manager_id,
  is_manager,
  google_status,
  currency_code,
  time_zone,
  last_synced_at,
  name_repair_attempted_at
) ON public.google_ads_accounts TO authenticated;

-- 3) Recommendations carry executable action_payload and their status is the
--    approval state machine. Audits and reports are server-generated evidence.
--    Keep RLS-scoped SELECT, but make every mutation service-role-only.
REVOKE INSERT, UPDATE, DELETE ON public.recommendations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.audits FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.reports FROM anon, authenticated;

-- 4) ai_actions is append-only history AND carries executable rollback
--    payloads. DELETE was already revoked; INSERT/UPDATE now go too. Every
--    app write path (recommendation execution, rollback state machine, the
--    nightly cron) uses the service role. SELECT stays for RLS-scoped reads.
REVOKE INSERT, UPDATE, DELETE ON public.ai_actions FROM anon, authenticated;

-- The authenticated health endpoint calls this with the service role. Keeping
-- the assertion in PostgreSQL lets production prove that the REVOKEs above
-- really took effect instead of merely proving that the migration file exists
-- in Git.
CREATE OR REPLACE FUNCTION public.modaafa_security_posture()
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'ok', NOT (
      has_table_privilege('anon', 'public.recommendations', 'INSERT') OR
      has_table_privilege('anon', 'public.recommendations', 'UPDATE') OR
      has_table_privilege('anon', 'public.recommendations', 'DELETE') OR
      has_table_privilege('authenticated', 'public.recommendations', 'INSERT') OR
      has_table_privilege('authenticated', 'public.recommendations', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.recommendations', 'DELETE') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'INSERT') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'DELETE') OR
      has_table_privilege('authenticated', 'public.audits', 'INSERT') OR
      has_table_privilege('authenticated', 'public.audits', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.audits', 'DELETE') OR
      has_table_privilege('authenticated', 'public.reports', 'INSERT') OR
      has_table_privilege('authenticated', 'public.reports', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.reports', 'DELETE') OR
      has_table_privilege('authenticated', 'public.users', 'INSERT') OR
      has_table_privilege('authenticated', 'public.users', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.users', 'DELETE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'refresh_token_encrypted', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'business_id', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'status', 'UPDATE')
    ),
    'recommendations_browser_write',
      has_table_privilege('authenticated', 'public.recommendations', 'INSERT') OR
      has_table_privilege('authenticated', 'public.recommendations', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.recommendations', 'DELETE'),
    'ai_actions_browser_write',
      has_table_privilege('authenticated', 'public.ai_actions', 'INSERT') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'DELETE'),
    'evidence_browser_write',
      has_table_privilege('authenticated', 'public.audits', 'INSERT') OR
      has_table_privilege('authenticated', 'public.audits', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.audits', 'DELETE') OR
      has_table_privilege('authenticated', 'public.reports', 'INSERT') OR
      has_table_privilege('authenticated', 'public.reports', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.reports', 'DELETE'),
    'identity_browser_write',
      has_table_privilege('authenticated', 'public.users', 'INSERT') OR
      has_table_privilege('authenticated', 'public.users', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.users', 'DELETE'),
    'google_credentials_browser_write',
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'refresh_token_encrypted', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'business_id', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'status', 'UPDATE')
  );
$$;

REVOKE ALL ON FUNCTION public.modaafa_security_posture() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.modaafa_security_posture() TO service_role;

-- 5) Keep the credential-bearing table for backward compatibility and key
--    rotation, but make it inaccessible to browser roles. A future DROP must
--    live in its own owner-approved migration after a verified backup.
DO $$
BEGIN
  IF to_regclass('public.pending_oauth_sessions') IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON TABLE public.pending_oauth_sessions FROM anon, authenticated';
  END IF;
END;
$$;
