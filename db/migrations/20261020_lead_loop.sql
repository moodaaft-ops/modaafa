-- =============================================================================
-- 2026-10-20 — Lead-quality loop (smart WhatsApp link, lead inbox, offline upload)
--
-- Ships dark behind LEAD_LOOP_ENABLED. Idempotent and additive; nothing here is
-- applied to production by the PR.
--
--   lead_loop_settings       one row per Google Ads account: public slug,
--                            merchant WhatsApp number, prefilled text, and the
--                            resolved "مُضاعِف | زبون فعلي" conversion action
--   lead_clicks              one row per visit to /w/<slug>: short ref code,
--                            click ids (gclid / gbraid / wbraid), utm, the
--                            merchant's verdict and the upload state
--   lead_conversion_uploads  append-only log of every upload attempt per lead
--   measurement_scans        when each account was last scanned for a tracking gap
--
-- No IP address, user agent or phone number of the visitor is stored. The
-- service role is the only writer; owners get RLS-scoped read access, the same
-- shape as autopilot_settings.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.lead_loop_settings (
  account_id UUID PRIMARY KEY REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z2-9]{8,16}$'),
  whatsapp_number TEXT NOT NULL CHECK (whatsapp_number ~ '^[1-9][0-9]{7,14}$'),
  default_text TEXT NOT NULL DEFAULT '' CHECK (char_length(default_text) <= 300),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  conversion_action_resource TEXT,
  conversion_action_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lead_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  ref_code TEXT NOT NULL CHECK (ref_code ~ '^M-[2-9A-HJKMNP-Z]{4,6}$'),
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  landing_path TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'customer', 'no_reply', 'not_serious')),
  marked_at TIMESTAMPTZ,
  value_sar NUMERIC(12, 2) CHECK (value_sar IS NULL OR (value_sar >= 0 AND value_sar <= 10000000)),
  upload_status TEXT NOT NULL DEFAULT 'none'
    CHECK (upload_status IN ('none', 'pending', 'uploading', 'uploaded', 'failed', 'skipped')),
  upload_attempts INTEGER NOT NULL DEFAULT 0 CHECK (upload_attempts >= 0),
  upload_claimed_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  upload_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_clicks_account_ref_key UNIQUE (account_id, ref_code)
);

CREATE INDEX IF NOT EXISTS idx_lead_clicks_account_date
  ON public.lead_clicks(account_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_clicks_upload_queue
  ON public.lead_clicks(account_id, marked_at)
  WHERE upload_status IN ('pending', 'uploading');

CREATE TABLE IF NOT EXISTS public.lead_conversion_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_click_id UUID NOT NULL REFERENCES public.lead_clicks(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL CHECK (outcome IN ('uploaded', 'duplicate', 'retry', 'failed', 'request_failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_uploads_lead
  ON public.lead_conversion_uploads(lead_click_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.measurement_scans (
  account_id UUID PRIMARY KEY REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  last_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_result JSONB NOT NULL DEFAULT '{}'::JSONB
);

ALTER TABLE public.lead_loop_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_conversion_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_loop_settings_owner_select ON public.lead_loop_settings;
CREATE POLICY lead_loop_settings_owner_select ON public.lead_loop_settings
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

DROP POLICY IF EXISTS lead_clicks_owner_select ON public.lead_clicks;
CREATE POLICY lead_clicks_owner_select ON public.lead_clicks
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

DROP POLICY IF EXISTS lead_conversion_uploads_owner_select ON public.lead_conversion_uploads;
CREATE POLICY lead_conversion_uploads_owner_select ON public.lead_conversion_uploads
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

REVOKE ALL ON TABLE public.lead_loop_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.lead_clicks FROM anon, authenticated;
REVOKE ALL ON TABLE public.lead_conversion_uploads FROM anon, authenticated;
REVOKE ALL ON TABLE public.measurement_scans FROM anon, authenticated;
GRANT SELECT ON TABLE public.lead_loop_settings TO authenticated;
GRANT SELECT ON TABLE public.lead_clicks TO authenticated;
GRANT SELECT ON TABLE public.lead_conversion_uploads TO authenticated;

-- ---------------------------------------------------------------------------
-- claim_lead_uploads: take up to p_limit leads that are waiting for upload and
-- flip them to 'uploading' in ONE statement, so two overlapping cron runs can
-- never send the same lead twice. A claim older than 15 minutes is a crashed
-- run and is taken over. Leads past p_max_attempts are marked failed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_lead_uploads(
  p_account_id UUID,
  p_limit INTEGER,
  p_max_attempts INTEGER
)
RETURNS TABLE (
  id UUID,
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  clicked_at TIMESTAMPTZ,
  marked_at TIMESTAMPTZ,
  value_sar NUMERIC,
  upload_attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.lead_clicks c
     SET upload_status = 'failed',
         upload_error = COALESCE(c.upload_error, 'max_attempts')
   WHERE c.account_id = p_account_id
     AND c.status = 'customer'
     AND c.upload_status = 'pending'
     AND c.upload_attempts >= p_max_attempts;

  RETURN QUERY
  WITH picked AS (
    SELECT c.id
      FROM public.lead_clicks c
     WHERE c.account_id = p_account_id
       AND c.status = 'customer'
       AND (
         c.upload_status = 'pending'
         OR (c.upload_status = 'uploading' AND c.upload_claimed_at < NOW() - INTERVAL '15 minutes')
       )
       AND c.upload_attempts < p_max_attempts
     ORDER BY c.marked_at
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.lead_clicks c
     SET upload_status = 'uploading',
         upload_claimed_at = NOW()
    FROM picked
   WHERE c.id = picked.id
  RETURNING c.id, c.gclid, c.gbraid, c.wbraid, c.clicked_at, c.marked_at, c.value_sar, c.upload_attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_lead_uploads(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_uploads(UUID, INTEGER, INTEGER) TO service_role;

COMMENT ON TABLE public.lead_clicks IS
  'One row per visit to the merchant smart WhatsApp link. Click ids and utm only: no IP, no user agent, no visitor phone.';
COMMENT ON TABLE public.lead_conversion_uploads IS
  'Append-only log of each offline click conversion upload attempt, one row per lead per attempt.';
