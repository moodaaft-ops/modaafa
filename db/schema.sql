-- =====================================================
-- Modaafa Database Schema
-- PostgreSQL 15+ (Supabase)
-- =====================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- USERS & BUSINESSES
-- =====================================================

CREATE TABLE IF NOT EXISTS users (
  -- Mirrors auth.users. The FK guarantees an out-of-band auth deletion
  -- cascades through the whole tenant tree (see 20260722 migration).
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,
  preferred_lang TEXT DEFAULT 'ar' CHECK (preferred_lang IN ('ar', 'en')),
  avatar_url TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One workspace per user. Without this a double submit created a second
  -- business row and every reader (which takes the newest) stopped seeing
  -- the linked ad accounts — the "returning user sent back to onboarding" bug.
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sector TEXT,
  website TEXT,
  target_regions TEXT[] DEFAULT '{}',
  primary_goal TEXT CHECK (primary_goal IN ('conversions', 'leads', 'traffic', 'awareness')),
  monthly_budget INT,
  context_summary TEXT,
  scraped_products JSONB,
  brand_voice JSONB,
  -- Server-validated per-user preference. The browser cookie is still
  -- cleared on sign-out, while this value restores the same account after
  -- the owner signs in again or moves to another device.
  selected_google_ads_customer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_businesses_user ON businesses(user_id);

-- =====================================================
-- GOOGLE ADS ACCOUNTS
-- =====================================================

CREATE TABLE IF NOT EXISTS google_ads_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  customer_name TEXT,
  manager_id TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  -- `status` is the LINK state inside Modaafa. `google_status` is what
  -- Google reports for the account itself (ENABLED / SUSPENDED / CLOSED …).
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'invitation_pending')),
  -- Manager (MCC) accounts must never receive a metrics query, otherwise
  -- Google answers REQUESTED_METRICS_FOR_MANAGER.
  is_manager BOOLEAN NOT NULL DEFAULT FALSE,
  google_status TEXT,
  name_repair_attempted_at TIMESTAMPTZ,
  permissions_scope TEXT[],
  currency_code TEXT,
  time_zone TEXT,
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  last_sync_attempt_at TIMESTAMPTZ,
  last_optimized_at TIMESTAMPTZ,
  UNIQUE(business_id, customer_id)
);

CREATE INDEX idx_gads_business ON google_ads_accounts(business_id);
CREATE INDEX idx_gads_status ON google_ads_accounts(status);
CREATE INDEX idx_gads_business_selectable ON google_ads_accounts(business_id, is_manager, status);
CREATE INDEX idx_gads_sync_queue ON google_ads_accounts(last_sync_attempt_at ASC NULLS FIRST)
  WHERE status = 'active' AND is_manager IS NOT TRUE;
CREATE INDEX idx_gads_optimize_queue ON google_ads_accounts(last_optimized_at ASC NULLS FIRST)
  WHERE status = 'active' AND is_manager IS NOT TRUE;

-- Legacy OAuth sessions are no longer created by the current one-consent
-- linking flow. Keep the table until an owner-approved, backed-up destructive
-- migration removes it; browser roles are denied all table privileges below.
CREATE TABLE IF NOT EXISTS pending_oauth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_encrypted TEXT NOT NULL,
  accessible_customers JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pending_oauth_user ON pending_oauth_sessions(user_id, expires_at);

-- =====================================================
-- AUDITS & RECOMMENDATIONS
-- =====================================================

CREATE TABLE IF NOT EXISTS audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  health_score INT CHECK (health_score BETWEEN 0 AND 100),
  category_scores JSONB,
  findings JSONB NOT NULL,
  metrics_snapshot JSONB,
  estimated_monthly_waste NUMERIC(10,2),
  ran_at TIMESTAMPTZ DEFAULT NOW(),
  duration_ms INT
);

CREATE INDEX idx_audits_account ON audits(account_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  category TEXT CHECK (category IN ('bidding', 'keywords', 'ads', 'structure', 'budget', 'targeting', 'extensions')),
  severity TEXT CHECK (severity IN ('critical', 'medium', 'growth')),
  title TEXT NOT NULL,
  description TEXT,
  expected_impact JSONB,
  action_payload JSONB,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'executing', 'applied', 'dismissed', 'failed')),
  fingerprint TEXT,
  execution_key UUID UNIQUE,
  execution_started_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  applied_by TEXT,
  applied_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recs_account_status ON recommendations(account_id, status);
CREATE INDEX idx_recs_audit ON recommendations(audit_id, created_at DESC);

-- =====================================================
-- AI ACTIONS LOG
-- =====================================================

CREATE TABLE IF NOT EXISTS ai_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  description_ar TEXT NOT NULL,
  description_en TEXT,
  reason TEXT,
  payload JSONB,
  result JSONB,
  expected_impact JSONB,
  observed_impact JSONB,
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
  execution_key UUID UNIQUE,
  rollback_payload JSONB,
  rollback_status TEXT CHECK (rollback_status IS NULL OR rollback_status IN ('executing', 'reverted', 'failed')),
  rollback_key UUID UNIQUE,
  rollback_started_at TIMESTAMPTZ,
  rollback_result JSONB,
  reverted_at TIMESTAMPTZ,
  reverted_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_actions_account_date ON ai_actions(account_id, created_at DESC);
CREATE INDEX idx_ai_actions_type ON ai_actions(action_type);

-- =====================================================
-- CAMPAIGNS CACHE (mirror of Google Ads data)
-- =====================================================

CREATE TABLE IF NOT EXISTS campaigns_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  google_campaign_id BIGINT NOT NULL,
  name TEXT,
  type TEXT CHECK (type IN ('SEARCH', 'DISPLAY', 'PMAX', 'SHOPPING', 'VIDEO', 'APP', 'LOCAL', 'DEMAND_GEN')),
  status TEXT,
  daily_budget NUMERIC(10,2),
  bidding_strategy TEXT,
  metrics_30d JSONB,
  metrics_7d JSONB,
  metrics_today JSONB,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, google_campaign_id)
);

CREATE INDEX idx_campaigns_account ON campaigns_cache(account_id);
CREATE INDEX idx_campaigns_account_synced ON campaigns_cache(account_id, last_synced_at DESC);

-- =====================================================
-- CHAT (Campaign Builder)
-- =====================================================

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES google_ads_accounts(id) ON DELETE SET NULL,
  title TEXT,
  draft_campaign JSONB,
  launched_campaign_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic ordering. Both turns of an exchange are inserted in one
  -- statement and therefore share the same transaction now(), so created_at
  -- cannot order them.
  seq BIGSERIAL,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT,
  tool_calls JSONB,
  tool_results JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
CREATE INDEX idx_chat_messages_session_seq ON chat_messages(session_id, seq);
CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX idx_chat_sessions_account ON chat_sessions(account_id);

-- =====================================================
-- SUBSCRIPTIONS & BILLING
-- =====================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'growth', 'pro')),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly', 'yearly')),
  status TEXT DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'paused')),
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  -- moyasar_subscription_id: retained for existing rows; the Moyasar
  -- integration was removed (dead code, never written to).
  moyasar_subscription_id TEXT,
  -- Stripe does not guarantee webhook ordering. Every lifecycle write is
  -- guarded on this so a late `updated` cannot resurrect a cancelled row.
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  canceled_at TIMESTAMPTZ
);

CREATE INDEX idx_subs_user ON subscriptions(user_id);
CREATE INDEX idx_subs_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS billing_trial_grants (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('checkout_complete', 'stripe_webhook')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- billing_trial_grants cascades away when an account is deleted, which
-- would let the same person re-register for unlimited free trials. This
-- ledger is keyed on a hash of the email and is never deleted.
-- Service role only: RLS enabled with no policy.
CREATE TABLE IF NOT EXISTS billing_trial_ledger (
  email_hash TEXT PRIMARY KEY,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_sar NUMERIC(10,2) NOT NULL,
  -- What Stripe actually billed. `amount_sar` is kept for history; new rows
  -- carry the real currency so a USD invoice is not rendered as riyals.
  currency TEXT NOT NULL DEFAULT 'SAR',
  status TEXT CHECK (status IN ('draft', 'pending', 'paid', 'failed', 'refunded')),
  invoice_number TEXT,
  invoice_url TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_user ON invoices(user_id, created_at DESC);
CREATE INDEX idx_invoices_subscription ON invoices(subscription_id);
CREATE UNIQUE INDEX invoices_user_number_uniq ON invoices (user_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- =====================================================
-- REPORTS
-- =====================================================

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES google_ads_accounts(id) ON DELETE CASCADE,
  period_type TEXT CHECK (period_type IN ('daily', 'weekly', 'monthly', 'custom')),
  period_start DATE,
  period_end DATE,
  summary_ar TEXT,
  summary_en TEXT,
  metrics JSONB,
  forecast JSONB,
  pdf_url TEXT,
  sent_via TEXT[],
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reports_account ON reports(account_id, generated_at DESC);

-- =====================================================
-- USAGE METERING AND BACKGROUND JOBS
-- =====================================================

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES google_ads_accounts(id) ON DELETE SET NULL,
  feature TEXT NOT NULL CHECK (feature IN ('assistant', 'campaign_builder', 'audit', 'manual_sync', 'execute_action')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_user_feature ON usage_events(user_id, feature, created_at DESC);
CREATE INDEX idx_usage_account ON usage_events(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  processed INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_runs_name ON job_runs(job_name, started_at DESC);

-- Anonymous per-(sector, currency) medians, recomputed nightly. Rows only
-- exist while at least three distinct businesses back the aggregate.
CREATE TABLE IF NOT EXISTS sector_benchmarks (
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

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_trial_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sector_benchmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY sector_benchmarks_read ON sector_benchmarks
  FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON sector_benchmarks FROM anon, authenticated;

-- Users can only see their own row
CREATE POLICY users_self_only ON users
  FOR ALL USING (id = auth.uid());

-- Businesses scoped to owner
CREATE POLICY businesses_owner_only ON businesses
  FOR ALL USING (user_id = auth.uid());

-- All other tables scoped via business → user
CREATE POLICY gads_owner_only ON google_ads_accounts
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid()));

CREATE POLICY pending_oauth_owner_only ON pending_oauth_sessions
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY audits_owner_only ON audits
  FOR ALL USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

CREATE POLICY recs_owner_only ON recommendations
  FOR ALL USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

CREATE POLICY actions_owner_only ON ai_actions
  FOR ALL USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

CREATE POLICY campaigns_owner_only ON campaigns_cache
  FOR SELECT USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

CREATE POLICY chat_sessions_owner_only ON chat_sessions
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY chat_messages_owner_only ON chat_messages
  FOR ALL USING (session_id IN (SELECT id FROM chat_sessions WHERE user_id = auth.uid()));

-- Billing state is written exclusively by the Stripe webhook and the
-- checkout-completion handler, both of which use the service role.
-- A `FOR ALL` policy here would let any authenticated user INSERT their
-- own `plan: 'pro', status: 'active'` row and unlock every paid feature.
CREATE POLICY subs_owner_select ON subscriptions
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY invoices_owner_select ON invoices
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY reports_owner_only ON reports
  FOR ALL USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

CREATE POLICY usage_events_owner_select ON usage_events
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY billing_trial_grants_owner_select ON billing_trial_grants
  FOR SELECT USING (user_id = (SELECT auth.uid()));

ALTER TABLE billing_trial_ledger ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- WRITE PRIVILEGES
-- RLS decides *which rows*; these REVOKEs decide *which verbs*.
-- Supabase grants ALL on public tables to anon/authenticated by default,
-- so a table that is only ever written by the service role must say so.
-- =====================================================

REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON invoices FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON billing_trial_grants FROM anon, authenticated;
REVOKE ALL ON TABLE billing_trial_ledger FROM anon, authenticated;

-- Metering rows are created through consume_feature_usage() only and refunded
-- by the service role only.
REVOKE INSERT, UPDATE, DELETE ON usage_events FROM anon, authenticated;

-- Append-only execution history AND executable rollback payloads. ai_actions
-- is written exclusively by the service role (recommendation execution, the
-- rollback state machine, the nightly cron), so the browser gets no write verb
-- at all — its rollback_payload is executed verbatim as a live Google Ads
-- mutation and must never be client-forgeable. SELECT stays for RLS reads.
REVOKE INSERT, UPDATE, DELETE ON ai_actions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON recommendations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON audits FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON reports FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON campaigns_cache FROM anon, authenticated;

-- Identity/profile writes are service-owned. A column-level REVOKE does not
-- override Supabase's default table-level UPDATE grant.
REVOKE INSERT, UPDATE, DELETE ON users FROM anon, authenticated;

-- Remove all default write verbs, then grant authenticated RLS-scoped routes
-- only harmless display/sync metadata. OAuth credentials, tenancy, link status,
-- insertion and deletion remain service-role-only.
REVOKE INSERT, UPDATE, DELETE ON google_ads_accounts FROM anon, authenticated;
GRANT UPDATE (
  customer_name,
  manager_id,
  is_manager,
  google_status,
  currency_code,
  time_zone,
  last_synced_at,
  name_repair_attempted_at
) ON google_ads_accounts TO authenticated;

-- Retained only for backward compatibility and encryption-key rotation.
REVOKE ALL PRIVILEGES ON pending_oauth_sessions FROM anon, authenticated;

CREATE OR REPLACE FUNCTION modaafa_security_posture()
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'ok', NOT (
      has_table_privilege('anon', 'public.recommendations', 'INSERT') OR
      has_table_privilege('anon', 'public.recommendations', 'UPDATE') OR
      has_table_privilege('anon', 'public.recommendations', 'DELETE') OR
      has_table_privilege('authenticated', 'public.recommendations', 'INSERT') OR
      has_table_privilege('authenticated', 'public.recommendations', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.recommendations', 'DELETE') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'INSERT') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'DELETE') OR
      has_table_privilege('authenticated', 'public.audits', 'INSERT') OR
      has_table_privilege('authenticated', 'public.audits', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.audits', 'DELETE') OR
      has_table_privilege('authenticated', 'public.reports', 'INSERT') OR
      has_table_privilege('authenticated', 'public.reports', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.reports', 'DELETE') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'INSERT') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'DELETE') OR
      has_table_privilege('authenticated', 'public.users', 'INSERT') OR
      has_table_privilege('authenticated', 'public.users', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.users', 'DELETE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'refresh_token_encrypted', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'business_id', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'status', 'UPDATE') OR
      has_function_privilege('authenticated', 'public.refund_feature_usage(uuid,uuid)', 'EXECUTE')
    ),
    'recommendations_browser_write',
      has_table_privilege('authenticated', 'public.recommendations', 'INSERT') OR
      has_table_privilege('authenticated', 'public.recommendations', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.recommendations', 'DELETE'),
    'ai_actions_browser_write',
      has_table_privilege('authenticated', 'public.ai_actions', 'INSERT') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.ai_actions', 'DELETE'),
    'evidence_browser_write',
      has_table_privilege('authenticated', 'public.audits', 'INSERT') OR
      has_table_privilege('authenticated', 'public.audits', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.audits', 'DELETE') OR
      has_table_privilege('authenticated', 'public.reports', 'INSERT') OR
      has_table_privilege('authenticated', 'public.reports', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.reports', 'DELETE'),
    'campaign_cache_browser_write',
      has_table_privilege('authenticated', 'public.campaigns_cache', 'INSERT') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.campaigns_cache', 'DELETE'),
    'identity_browser_write',
      has_table_privilege('authenticated', 'public.users', 'INSERT') OR
      has_table_privilege('authenticated', 'public.users', 'UPDATE') OR
      has_table_privilege('authenticated', 'public.users', 'DELETE'),
    'google_credentials_browser_write',
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'refresh_token_encrypted', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'business_id', 'UPDATE') OR
      has_column_privilege('authenticated', 'public.google_ads_accounts', 'status', 'UPDATE'),
    'usage_refund_browser_execute',
      has_function_privilege('authenticated', 'public.refund_feature_usage(uuid,uuid)', 'EXECUTE')
  );
$$;
REVOKE ALL ON FUNCTION modaafa_security_posture() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION modaafa_security_posture() TO service_role;

-- =====================================================
-- TRIGGERS
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_businesses_updated_at BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chat_sessions_updated_at BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Keep public.users aligned with Supabase Auth users.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = COALESCE(EXCLUDED.name, public.users.name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, public.users.avatar_url),
    last_login_at = NOW(),
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ============================================================
-- Server-side OAuth state storage (single-use, 60-min TTL).
-- Service-role only: RLS enabled with no policies.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'google_ads_connect',
  return_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON public.oauth_states (expires_at);
CREATE INDEX IF NOT EXISTS oauth_states_user_id_idx ON public.oauth_states (user_id);

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Rate limiting (fixed windows). Service-role only:
-- RLS enabled, privileges revoked, access via consume_rate_limit().
-- (Kept in sync with db/migrations/20260721_rate_limits.sql.)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rate_limit_windows (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.rate_limit_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_windows FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS rate_limit_windows_updated_idx
  ON public.rate_limit_windows (updated_at);

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_key TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  IF p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate limit configuration';
  END IF;

  INSERT INTO public.rate_limit_windows AS limits (key, window_start, request_count, updated_at)
  VALUES (p_key, v_now, 1, v_now)
  ON CONFLICT (key) DO UPDATE
    SET window_start = CASE
          WHEN limits.window_start + MAKE_INTERVAL(secs => p_window_seconds) <= v_now THEN v_now
          ELSE limits.window_start
        END,
        request_count = CASE
          WHEN limits.window_start + MAKE_INTERVAL(secs => p_window_seconds) <= v_now THEN 1
          ELSE limits.request_count + 1
        END,
        updated_at = v_now
  RETURNING limits.window_start, limits.request_count
    INTO v_window_start, v_count;

  RETURN QUERY SELECT
    v_count <= p_limit,
    GREATEST(0, p_limit - v_count),
    v_window_start + MAKE_INTERVAL(secs => p_window_seconds);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT, INTEGER, INTEGER) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;

-- ============================================================
-- Metered feature usage (assistant / audit / execute_action).
-- Callable only by the authenticated user for their own id.
-- (Kept in sync with db/migrations/20260721_billing_usage_safety.sql.)
-- ============================================================
CREATE OR REPLACE FUNCTION public.consume_feature_usage(
  p_user_id UUID,
  p_feature TEXT,
  p_account_id UUID,
  p_limit INTEGER,
  p_window_start TIMESTAMPTZ,
  p_window_end TIMESTAMPTZ,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (allowed BOOLEAN, used INTEGER, event_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_used INTEGER;
  v_event_id UUID;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_limit < 1 OR p_window_end <= p_window_start THEN
    RAISE EXCEPTION 'invalid usage window';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_feature || ':' || p_window_start::text, 0)
  );

  SELECT COUNT(*)::integer INTO v_used
  FROM public.usage_events
  WHERE user_id = p_user_id
    AND feature = p_feature
    AND created_at >= p_window_start
    AND created_at < p_window_end;

  IF v_used >= p_limit THEN
    RETURN QUERY SELECT false, v_used, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.usage_events (user_id, account_id, feature, metadata)
  VALUES (p_user_id, p_account_id, p_feature, COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_event_id;

  RETURN QUERY SELECT true, v_used + 1, v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_feature_usage(
  p_user_id UUID,
  p_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted UUID;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  DELETE FROM public.usage_events
  WHERE id = p_event_id AND user_id = p_user_id
  RETURNING id INTO v_deleted;

  RETURN v_deleted IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_feature_usage(UUID, TEXT, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) FROM public;
GRANT EXECUTE ON FUNCTION public.consume_feature_usage(UUID, TEXT, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.refund_feature_usage(UUID, UUID) FROM public;
REVOKE ALL ON FUNCTION public.refund_feature_usage(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_feature_usage(UUID, UUID) TO service_role;
