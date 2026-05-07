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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sector TEXT,
  website TEXT,
  target_regions TEXT[] DEFAULT '{}',
  primary_goal TEXT CHECK (primary_goal IN ('conversions', 'leads', 'traffic', 'awareness')),
  monthly_budget INT,
  context_summary TEXT,
  scraped_products JSONB,
  brand_voice JSONB,
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
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'invitation_pending')),
  permissions_scope TEXT[],
  currency_code TEXT,
  time_zone TEXT,
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  UNIQUE(customer_id)
);

CREATE INDEX idx_gads_business ON google_ads_accounts(business_id);
CREATE INDEX idx_gads_status ON google_ads_accounts(status);

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
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'applied', 'dismissed', 'failed')),
  applied_at TIMESTAMPTZ,
  applied_by TEXT,
  applied_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recs_account_status ON recommendations(account_id, status);

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
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT,
  tool_calls JSONB,
  tool_results JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);

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
  moyasar_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  canceled_at TIMESTAMPTZ
);

CREATE INDEX idx_subs_user ON subscriptions(user_id);
CREATE INDEX idx_subs_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_sar NUMERIC(10,2) NOT NULL,
  status TEXT CHECK (status IN ('draft', 'pending', 'paid', 'failed', 'refunded')),
  invoice_number TEXT,
  invoice_url TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Users can only see their own row
CREATE POLICY users_self_only ON users
  FOR ALL USING (id = auth.uid());

-- Businesses scoped to owner
CREATE POLICY businesses_owner_only ON businesses
  FOR ALL USING (user_id = auth.uid());

-- All other tables scoped via business → user
CREATE POLICY gads_owner_only ON google_ads_accounts
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid()));

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
  FOR ALL USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

CREATE POLICY chat_sessions_owner_only ON chat_sessions
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY chat_messages_owner_only ON chat_messages
  FOR ALL USING (session_id IN (SELECT id FROM chat_sessions WHERE user_id = auth.uid()));

CREATE POLICY subs_owner_only ON subscriptions
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY invoices_owner_only ON invoices
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY reports_owner_only ON reports
  FOR ALL USING (account_id IN (
    SELECT id FROM google_ads_accounts
    WHERE business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  ));

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
