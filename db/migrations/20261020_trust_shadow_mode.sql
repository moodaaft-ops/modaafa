-- =============================================================================
-- 2026-10-20 — Shadow mode for agency accounts
--
-- Ships dark behind SHADOW_MODE_ENABLED. Idempotent and additive. Operator-only:
-- none of these tables has an owner policy, and authenticated/anon get no grant,
-- so only the service role reads or writes them.
--
--   shadow_accounts   accounts an operator marked as shadow (no merchant, no
--                     execution, ever). Presence of a row is the whole flag.
--   shadow_decisions  what the optimizer would have done. Deliberately NOT in
--                     public.recommendations, so no approval or execution path
--                     can pick one up.
--   shadow_reviews    the operator's verdict on a decision, or a miss.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.shadow_accounts (
  account_id UUID PRIMARY KEY REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  marked_by UUID,
  note TEXT,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.shadow_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  job_run_id UUID,
  action_type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  target_id TEXT,
  action JSONB NOT NULL DEFAULT '{}'::JSONB,
  reason_ar TEXT,
  confidence NUMERIC(4, 3),
  executable BOOLEAN NOT NULL DEFAULT FALSE CHECK (executable = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_decisions_account_date
  ON public.shadow_decisions(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.shadow_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES public.shadow_decisions(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('right', 'wrong', 'missed')),
  category TEXT NOT NULL DEFAULT 'other',
  note TEXT,
  reviewed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A right or wrong verdict is about a decision; only a miss stands alone.
  CONSTRAINT shadow_reviews_decision_matches_verdict CHECK (
    (verdict = 'missed' AND decision_id IS NULL) OR (verdict IN ('right', 'wrong') AND decision_id IS NOT NULL)
  )
);

-- One verdict per decision; changing your mind replaces it. A plain unique
-- index (NULLs are distinct, so misses are unaffected) so an upsert can name it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_reviews_one_per_decision
  ON public.shadow_reviews(decision_id);
CREATE INDEX IF NOT EXISTS idx_shadow_reviews_account_date
  ON public.shadow_reviews(account_id, created_at DESC);

ALTER TABLE public.shadow_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shadow_accounts FROM anon, authenticated;
REVOKE ALL ON TABLE public.shadow_decisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.shadow_reviews FROM anon, authenticated;

COMMENT ON TABLE public.shadow_accounts IS 'Agency accounts the optimizer reads but never acts on. Operator-only, service role.';
COMMENT ON TABLE public.shadow_decisions IS 'What the optimizer would have done on a shadow account. executable is always false.';
COMMENT ON TABLE public.shadow_reviews IS 'Operator verdicts on shadow decisions (right, wrong) and things the optimizer missed.';
