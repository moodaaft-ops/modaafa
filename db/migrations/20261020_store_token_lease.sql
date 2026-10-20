-- Salla refresh tokens are single use: two concurrent refreshes would burn the
-- token and disconnect the store. A short database lease makes one caller win.
ALTER TABLE public.store_connections
  ADD COLUMN IF NOT EXISTS refresh_lease_until TIMESTAMPTZ;
-- Not added to the owner's column grant (20261020_store_orders.sql): server only.

-- Atomic: a single UPDATE takes the row lock, so exactly one caller sees TRUE
-- until the lease expires or is released. Service role only.
CREATE OR REPLACE FUNCTION public.claim_store_token_refresh(p_connection UUID, p_lease_seconds INTEGER DEFAULT 30)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE public.store_connections
     SET refresh_lease_until = NOW() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 120)))
   WHERE id = p_connection
     AND status = 'active'
     AND (refresh_lease_until IS NULL OR refresh_lease_until < NOW())
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_store_token_refresh(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_store_token_refresh(UUID, INTEGER) TO service_role;
