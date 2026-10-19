-- =============================================================================
-- 2026-10-20 — Agency handoff flags
--
-- Ships dark behind AGENCY_HANDOFF_ENABLED. Idempotent and additive. One row per
-- account: the rules write reasons and the spend they saw; the merchant's tap on
-- the card writes asked_at; an operator closes it with handled_at. Written by
-- the service role only. Owners read their own row.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.agency_handoffs (
  account_id UUID PRIMARY KEY REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  spend_30d_sar NUMERIC(14, 2),
  policy_flagged_ads INTEGER,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asked_at TIMESTAMPTZ,
  handled_at TIMESTAMPTZ,
  handled_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_handoffs_open
  ON public.agency_handoffs(evaluated_at DESC)
  WHERE handled_at IS NULL;

ALTER TABLE public.agency_handoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agency_handoffs_owner_select ON public.agency_handoffs;
CREATE POLICY agency_handoffs_owner_select ON public.agency_handoffs
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

REVOKE ALL ON TABLE public.agency_handoffs FROM anon, authenticated;
GRANT SELECT ON TABLE public.agency_handoffs TO authenticated;

COMMENT ON TABLE public.agency_handoffs IS
  'Accounts that look bigger than the platform, plus the merchant''s request for the team. Service role writes.';
