-- Store sync: connections and orders for Salla / Zid. Service role writes; owners read.
CREATE TABLE IF NOT EXISTS public.store_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.google_ads_accounts(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('salla', 'zid', 'shopify')),
  external_store_id TEXT NOT NULL,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT store_connections_platform_store_key UNIQUE (platform, external_store_id)
);

CREATE TABLE IF NOT EXISTS public.store_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.store_connections(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('salla', 'zid', 'shopify')),
  external_id TEXT NOT NULL,
  status TEXT,
  total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
  currency TEXT NOT NULL DEFAULT 'SAR',
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  placed_at TIMESTAMPTZ,
  gclid TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  ref_code TEXT,
  lead_click_id UUID REFERENCES public.lead_clicks(id) ON DELETE SET NULL,
  match_method TEXT NOT NULL DEFAULT 'none' CHECK (match_method IN ('gclid', 'ref_code', 'none')),
  last_event TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT store_orders_conn_ext_key UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_store_orders_conn_date ON public.store_orders(connection_id, placed_at DESC);

ALTER TABLE public.store_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS store_connections_owner_select ON public.store_connections;
CREATE POLICY store_connections_owner_select ON public.store_connections FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS store_orders_owner_select ON public.store_orders;
CREATE POLICY store_orders_owner_select ON public.store_orders FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.store_connections c WHERE c.id = connection_id AND c.user_id = (SELECT auth.uid())));

-- Writes are service role only (RLS has no write policy; the grants say so too).
REVOKE INSERT, UPDATE, DELETE ON public.store_connections FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.store_orders FROM anon, authenticated;
REVOKE ALL ON public.store_orders FROM anon;
-- The encrypted store tokens never reach the browser: the owner may read only the non-secret columns.
REVOKE SELECT ON public.store_connections FROM anon, authenticated;
GRANT SELECT (id, user_id, account_id, platform, external_store_id, status, last_error, created_at, updated_at)
  ON public.store_connections TO authenticated;
