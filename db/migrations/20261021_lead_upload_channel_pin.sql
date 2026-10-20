-- Server-only channel pin survives row isolation, retries and process crashes.
ALTER TABLE public.lead_clicks ADD COLUMN IF NOT EXISTS upload_channel TEXT
  CHECK (upload_channel IN ('legacy', 'data_manager'));

DROP FUNCTION IF EXISTS public.claim_lead_uploads(UUID, INTEGER, INTEGER);
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
  upload_attempts INTEGER,
  upload_channel TEXT
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
  RETURNING c.id, c.gclid, c.gbraid, c.wbraid, c.clicked_at, c.marked_at, c.value_sar, c.upload_attempts, c.upload_channel;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_lead_uploads(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_uploads(UUID, INTEGER, INTEGER) TO service_role;

