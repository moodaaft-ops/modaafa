-- Fair round-robin cursors for the hourly background jobs.
--
-- last_synced_at records a SUCCESS and must not be advanced by failed calls.
-- Ordering on it therefore lets one permanently failing account monopolise the
-- front of every batch. These attempt cursors advance after every attempted
-- account, while the success timestamp keeps its original reporting meaning.
-- Forward-only and safe to re-run.

ALTER TABLE public.google_ads_accounts
  ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_optimized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gads_sync_queue
  ON public.google_ads_accounts (last_sync_attempt_at ASC NULLS FIRST)
  WHERE status = 'active' AND is_manager IS NOT TRUE;

CREATE INDEX IF NOT EXISTS idx_gads_optimize_queue
  ON public.google_ads_accounts (last_optimized_at ASC NULLS FIRST)
  WHERE status = 'active' AND is_manager IS NOT TRUE;

-- Browser clients do not operate the background queue cursors.
REVOKE UPDATE (last_sync_attempt_at, last_optimized_at)
  ON public.google_ads_accounts FROM anon, authenticated;
