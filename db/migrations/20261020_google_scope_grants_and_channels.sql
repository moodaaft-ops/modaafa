-- Separate Google consents (Data Manager, GA4, GBP) and upload channel state.
CREATE TABLE IF NOT EXISTS public.google_scope_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK (feature IN ('data_manager', 'ga4', 'gbp')),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  refresh_token_encrypted TEXT,
  google_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT google_scope_grants_user_feature_key UNIQUE (user_id, feature)
);
ALTER TABLE public.google_scope_grants ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (tokens never reach the browser).
REVOKE ALL ON public.google_scope_grants FROM anon, authenticated;

ALTER TABLE public.lead_loop_settings
  ADD COLUMN IF NOT EXISTS upload_channel TEXT,
  ADD COLUMN IF NOT EXISTS legacy_blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_upload_channel TEXT;
ALTER TABLE public.lead_conversion_uploads
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS request_id TEXT;
