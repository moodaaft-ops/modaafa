-- =============================================================================
-- 2026-10-12: Jarvis permission answer, write-access probe, business memory
-- (spec 83, PR-J6 and PR-J7)
--
-- Forward-only, non-destructive and safe to run repeatedly. Nothing here
-- turns on automatic execution: the global AUTOPILOT_EXECUTION_ENABLED switch
-- and autopilot_settings.mode stay exactly as they are.
-- =============================================================================

-- PR-J6: the customer's answer to the one permission question. It is a record
-- of consent only; mode changes stay in /api/autopilot/settings and a reviewed
-- one-off script once the global switch opens.
ALTER TABLE public.autopilot_settings
  ADD COLUMN IF NOT EXISTS consent JSONB,
  ADD COLUMN IF NOT EXISTS small_spend_cap NUMERIC(10, 2);

ALTER TABLE public.autopilot_settings
  DROP CONSTRAINT IF EXISTS autopilot_settings_consent_shape;
ALTER TABLE public.autopilot_settings
  ADD CONSTRAINT autopilot_settings_consent_shape CHECK (
    consent IS NULL OR (
      jsonb_typeof(consent) = 'object'
      AND consent->>'answer' IN ('auto_small', 'always_ask')
      AND consent->>'channel' IN ('chat', 'voice', 'settings')
    )
  );

ALTER TABLE public.autopilot_settings
  DROP CONSTRAINT IF EXISTS autopilot_settings_small_spend_cap_range;
ALTER TABLE public.autopilot_settings
  ADD CONSTRAINT autopilot_settings_small_spend_cap_range CHECK (
    small_spend_cap IS NULL OR (small_spend_cap >= 0 AND small_spend_cap <= 100000)
  );

-- PR-J6: result of the validate-only probe. 'unknown' until first checked.
ALTER TABLE public.google_ads_accounts
  ADD COLUMN IF NOT EXISTS write_access TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS write_access_checked_at TIMESTAMPTZ;

ALTER TABLE public.google_ads_accounts
  DROP CONSTRAINT IF EXISTS google_ads_accounts_write_access_check;
ALTER TABLE public.google_ads_accounts
  ADD CONSTRAINT google_ads_accounts_write_access_check
  CHECK (write_access IN ('full', 'read_only', 'unknown'));

-- PR-J7: facts about the business, each with its source and basis.
CREATE TABLE IF NOT EXISTS public.business_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.google_ads_accounts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('margin', 'product', 'season', 'schedule', 'geo', 'goal',
    'capacity', 'constraint', 'preference', 'agency', 'outcome', 'other')),
  fact_ar TEXT NOT NULL CHECK (char_length(fact_ar) BETWEEN 1 AND 300),
  data JSONB NOT NULL DEFAULT '{}'::JSONB,
  source TEXT NOT NULL CHECK (source IN ('chat', 'voice', 'onboarding', 'action_outcome', 'weekly_review', 'settings')),
  source_ref TEXT,
  basis TEXT NOT NULL CHECK (basis IN ('stated', 'measured', 'inferred')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
  superseded_by UUID REFERENCES public.business_memory(id),
  valid_from DATE,
  valid_until DATE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_memory_active
  ON public.business_memory(business_id, status, kind);

-- One outcome fact per executed action, so the outcome writer is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS business_memory_outcome_ref_idx
  ON public.business_memory(source_ref)
  WHERE source = 'action_outcome' AND source_ref IS NOT NULL;

ALTER TABLE public.business_memory ENABLE ROW LEVEL SECURITY;

-- The owner reads their own facts. Writes (save, delete as status change)
-- happen on the server with the service role after ownership is proven.
DROP POLICY IF EXISTS business_memory_owner_read ON public.business_memory;
CREATE POLICY business_memory_owner_read ON public.business_memory
  FOR SELECT USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

REVOKE ALL ON TABLE public.business_memory FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.business_memory TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.business_memory TO service_role;
