-- =====================================================================
-- Sector benchmarks — 2026-07-30
--
-- Anonymous per-(sector, currency) medians computed nightly by the optimize
-- cron from campaigns_cache. Rows are written ONLY when a group covers at
-- least 3 distinct businesses (k-anonymity), and only aggregates are stored.
-- Readable by any signed-in user (it is exactly the "how do I compare to my
-- sector?" feature); written exclusively by the service role.
--
-- Forward-only. Safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.sector_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sector TEXT NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'SAR',
  window_days INT NOT NULL DEFAULT 30,
  businesses_count INT NOT NULL,
  accounts_count INT NOT NULL,
  median_cpa NUMERIC(12, 2),
  median_ctr NUMERIC(8, 6),
  median_roas NUMERIC(10, 2),
  median_cpc NUMERIC(12, 2),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sector_benchmarks_businesses_k_check CHECK (businesses_count >= 3),
  CONSTRAINT sector_benchmarks_accounts_check CHECK (accounts_count >= businesses_count),
  CONSTRAINT sector_benchmarks_window_check CHECK (window_days > 0),
  UNIQUE (sector, currency_code, window_days)
);

-- CREATE TABLE IF NOT EXISTS does not retrofit constraints when this migration
-- is re-run against an earlier draft of the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sector_benchmarks_businesses_k_check'
      AND conrelid = 'public.sector_benchmarks'::regclass
  ) THEN
    ALTER TABLE public.sector_benchmarks
      ADD CONSTRAINT sector_benchmarks_businesses_k_check CHECK (businesses_count >= 3);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sector_benchmarks_accounts_check'
      AND conrelid = 'public.sector_benchmarks'::regclass
  ) THEN
    ALTER TABLE public.sector_benchmarks
      ADD CONSTRAINT sector_benchmarks_accounts_check CHECK (accounts_count >= businesses_count);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sector_benchmarks_window_check'
      AND conrelid = 'public.sector_benchmarks'::regclass
  ) THEN
    ALTER TABLE public.sector_benchmarks
      ADD CONSTRAINT sector_benchmarks_window_check CHECK (window_days > 0);
  END IF;
END;
$$;

ALTER TABLE public.sector_benchmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sector_benchmarks_read ON public.sector_benchmarks;
CREATE POLICY sector_benchmarks_read ON public.sector_benchmarks
  FOR SELECT TO authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.sector_benchmarks FROM anon, authenticated;
