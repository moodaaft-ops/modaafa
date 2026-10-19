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

-- Accounts that already chose the conservative mode keep the behaviour they
-- opted into (automatic exact negatives) once the flag is turned on. Everyone
-- else starts at ask_all. DO NOTHING keeps reruns and later choices intact.
INSERT INTO public.autopilot_autonomy (account_id, level)
SELECT account_id, 'small_and_notify'
FROM public.autopilot_settings
WHERE mode = 'conservative'
ON CONFLICT (account_id) DO NOTHING;

COMMENT ON TABLE public.autopilot_autonomy IS
  'Merchant-chosen autonomy level (ask_all or small_and_notify). Hard ceilings are in code, not here.';
