-- =============================================================================
-- 2026-08-12 — Independent audit security and integrity hardening
--
-- Forward-only and safe to run repeatedly.
-- =============================================================================

-- Usage refunds are compensation owned by trusted server routes. A signed-in
-- browser can read its ledger for transparency, but cannot erase that ledger.
CREATE OR REPLACE FUNCTION public.refund_feature_usage(
  p_user_id UUID,
  p_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted UUID;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  DELETE FROM public.usage_events
  WHERE id = p_event_id AND user_id = p_user_id
  RETURNING id INTO v_deleted;

  RETURN v_deleted IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_feature_usage(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_feature_usage(UUID, UUID) TO service_role;

-- Match db/schema.sql to the production migration invariant: metering rows are
-- reserved through consume_feature_usage(), never inserted directly.
REVOKE INSERT, UPDATE, DELETE ON public.usage_events FROM anon, authenticated;
DROP POLICY IF EXISTS usage_events_owner_insert ON public.usage_events;

-- Campaign performance cache feeds cross-tenant anonymous benchmarks. Only
-- trusted server sync jobs may write it; users retain RLS-scoped reads.
DROP POLICY IF EXISTS campaigns_owner_only ON public.campaigns_cache;
CREATE POLICY campaigns_owner_only ON public.campaigns_cache
  FOR SELECT USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));
REVOKE INSERT, UPDATE, DELETE ON public.campaigns_cache FROM anon, authenticated;

-- Extend the production-verifiable posture so a future accidental GRANT makes
-- /api/health fail closed instead of silently reopening quota bypasses.
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
      has_table_privilege('authenticated', 'public.campaigns_cache', 'INSERT') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'DELETE') OR
      has_table_privilege('authenticated', 'public.users', 'INSERT') OR
      has_table_privilege('authenticated', 'public.users', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.users', 'DELETE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'refresh_token_encrypted', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'business_id', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'status', 'UPDATE') OR
      has_function_privilege('authenticated', 'public.refund_feature_usage(uuid,uuid)', 'EXECUTE')
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
    'campaign_cache_browser_write',
      has_table_privilege('authenticated', 'public.campaigns_cache', 'INSERT') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'DELETE'),
    'identity_browser_write',
      has_table_privilege('authenticated', 'public.users', 'INSERT') OR
      has_table_privilege('authenticated', 'public.users', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.users', 'DELETE'),
    'google_credentials_browser_write',
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'refresh_token_encrypted', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'business_id', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'status', 'UPDATE'),
    'usage_refund_browser_execute',
      has_function_privilege('authenticated', 'public.refund_feature_usage(uuid,uuid)', 'EXECUTE')
  );
$$;

REVOKE ALL ON FUNCTION public.modaafa_security_posture() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.modaafa_security_posture() TO service_role;
