-- =============================================================================
-- 2026-10-20 — Landing page checks (weekly, per account)
--
-- Ships dark behind LANDING_CHECK_ENABLED. Idempotent and additive; nothing here
-- is applied to production by the PR. The service role is the only writer; owners
-- get RLS-scoped read access, the same shape as autopilot_settings.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.landing_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_landing_checks_account_date
  ON public.landing_checks(account_id, checked_at DESC);

ALTER TABLE public.landing_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landing_checks_owner_select ON public.landing_checks;
CREATE POLICY landing_checks_owner_select ON public.landing_checks
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

REVOKE ALL ON TABLE public.landing_checks FROM anon, authenticated;
GRANT SELECT ON TABLE public.landing_checks TO authenticated;

COMMENT ON TABLE public.landing_checks IS
  'Weekly landing page check per account: status, timings, tags, mobile setup, message match. Written by the service role only.';
