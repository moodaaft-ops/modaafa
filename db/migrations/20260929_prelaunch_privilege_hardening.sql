-- Pre-launch privilege hardening (2026-09-29).
--
-- 1. The owner policies on businesses and google_ads_accounts are FOR ALL, so a
--    signed-in user could DELETE their own workspace straight through the
--    public API with the anon key. That cascaded away the autopilot decision
--    ledger, the audit/recommendation history and the only stored copy of the
--    encrypted refresh token, while the Google Ads grant itself stayed live at
--    Google with no record on our side. Account deletion already goes through
--    /api/account/delete with the service role, which revokes the Google grant
--    and cancels Stripe first, so the browser roles never need DELETE here.
-- 2. consume_feature_usage is SECURITY DEFINER and was executable by anon via
--    the default PUBLIC grant. The body rejects a NULL auth.uid(), but there is
--    no reason to expose it to signed-out callers at all.
-- 3. update_updated_at_column had a mutable search_path (Supabase linter).
--
-- Idempotent: safe to run more than once.

REVOKE DELETE ON public.businesses FROM anon, authenticated;
REVOKE DELETE ON public.google_ads_accounts FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.consume_feature_usage(
  uuid, text, uuid, integer, timestamptz, timestamptz, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_feature_usage(
  uuid, text, uuid, integer, timestamptz, timestamptz, jsonb
) TO authenticated, service_role;

ALTER FUNCTION public.update_updated_at_column() SET search_path = public;

-- Verification (expected: all false, then true):
-- SELECT has_table_privilege('authenticated', 'public.businesses', 'DELETE'),
--        has_table_privilege('authenticated', 'public.google_ads_accounts', 'DELETE'),
--        has_function_privilege('anon', 'public.consume_feature_usage(uuid,text,uuid,integer,timestamptz,timestamptz,jsonb)', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.consume_feature_usage(uuid,text,uuid,integer,timestamptz,timestamptz,jsonb)', 'EXECUTE');
