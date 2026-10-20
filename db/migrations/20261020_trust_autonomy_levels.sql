-- =============================================================================
-- 2026-10-20 — Autonomy level per account
--
-- Ships dark behind AUTONOMY_LEVELS_ENABLED. Idempotent and additive. The level
-- lives beside autopilot_settings (not inside it) so the save_autopilot_settings
-- RPC and its CHECK constraints stay untouched. A missing row means ask_all.
-- Written by the service role only, after the route has checked ownership.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.autopilot_autonomy (
  account_id UUID PRIMARY KEY REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'ask_all'
    CHECK (level IN ('ask_all', 'small_and_notify')),
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.autopilot_autonomy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_autonomy_owner_select ON public.autopilot_autonomy;
CREATE POLICY autopilot_autonomy_owner_select ON public.autopilot_autonomy
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

REVOKE ALL ON TABLE public.autopilot_autonomy FROM anon, authenticated;
GRANT SELECT ON TABLE public.autopilot_autonomy TO authenticated;

-- No backfill: every account starts at ask_all (no row) and the merchant
-- picks small_and_notify himself. The small level also pauses keywords, which
-- owners of the old conservative mode never agreed to (review finding L1).

COMMENT ON TABLE public.autopilot_autonomy IS
  'Merchant-chosen autonomy level (ask_all or small_and_notify). Hard ceilings are in code, not here.';
