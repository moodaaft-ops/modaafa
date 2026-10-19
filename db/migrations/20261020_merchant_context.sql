-- =====================================================================
-- Merchant context, 2026-10-20 (GAP-144 item 40, flag BUSINESS_MEMORY_ENABLED)
--
-- Short-lived facts the merchant tells Jarvis about the next days or weeks:
-- an offer that is coming, a product that is out of stock, a price change,
-- the hours the shop is busy. Unlike business_memory (durable facts: margin,
-- branches, goals) these EXPIRE, and the optimizer, the monthly session and
-- the morning guard read the ones that are active today.
--
-- Written by the server (service role) when Jarvis calls save_merchant_context
-- and the quote is found word for word in the merchant's own message. The
-- owner reads their own rows. Idempotent. Nothing reads this table until
-- BUSINESS_MEMORY_ENABLED=true.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.merchant_context_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.google_ads_accounts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upcoming_offer', 'stock_out', 'price_change', 'busy_hours', 'other')),
  fact_ar TEXT NOT NULL CHECK (char_length(fact_ar) BETWEEN 1 AND 300),
  -- The merchant's own words (quote) and anything structured we keep with it.
  data JSONB NOT NULL DEFAULT '{}'::JSONB,
  source TEXT NOT NULL CHECK (source IN ('chat', 'voice', 'settings')),
  source_ref TEXT,
  -- The window the fact applies to. effective_until is always set by the
  -- server (a default per kind when the merchant gave no date), so no fact
  -- stays "active" forever by accident.
  effective_from DATE,
  effective_until DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_context_active
  ON public.merchant_context_facts(business_id, status, effective_until);

ALTER TABLE public.merchant_context_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_context_owner_read ON public.merchant_context_facts;
CREATE POLICY merchant_context_owner_read ON public.merchant_context_facts
  FOR SELECT USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

REVOKE ALL ON TABLE public.merchant_context_facts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.merchant_context_facts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.merchant_context_facts TO service_role;

-- Verification (run manually after applying):
--   select count(*) from information_schema.tables
--    where table_schema = 'public' and table_name = 'merchant_context_facts';                     -- 1
--   select relrowsecurity from pg_class where oid = 'public.merchant_context_facts'::regclass;     -- true
