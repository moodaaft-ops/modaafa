-- =============================================================================
-- 2026-08-25 — Opt-in Google Ads autopilot settings and append-only decisions
--
-- Forward-only, non-destructive and safe to run repeatedly.
-- The service role is the only writer. Owners receive RLS-scoped read access.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.autopilot_settings (
  account_id UUID PRIMARY KEY REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off'
    CHECK (mode IN ('off', 'observe', 'conservative')),
  allowed_actions TEXT[] NOT NULL DEFAULT ARRAY['add_negative_keyword']::TEXT[],
  max_daily_changes INTEGER NOT NULL DEFAULT 3
    CHECK (max_daily_changes BETWEEN 1 AND 3),
  min_confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.950
    CHECK (min_confidence BETWEEN 0.950 AND 1.000),
  cooldown_hours INTEGER NOT NULL DEFAULT 48
    CHECK (cooldown_hours BETWEEN 24 AND 168),
  require_healthy_tracking BOOLEAN NOT NULL DEFAULT TRUE,
  anomaly_pause_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  terms_accepted_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  pause_reason TEXT,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.autopilot_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
  job_run_id UUID REFERENCES public.job_runs(id) ON DELETE SET NULL,
  recommendation_id UUID REFERENCES public.recommendations(id) ON DELETE SET NULL,
  ai_action_id UUID REFERENCES public.ai_actions(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'conservative')),
  action_type TEXT,
  target_id TEXT,
  decision TEXT NOT NULL
    CHECK (decision IN ('settings_changed', 'observed', 'queued', 'executed', 'unverified', 'blocked', 'failed', 'no_action')),
  policy_version TEXT NOT NULL,
  confidence NUMERIC(4, 3),
  reason_ar TEXT,
  action_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  policy_checks JSONB NOT NULL DEFAULT '{}'::JSONB,
  google_validation JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_account_date
  ON public.autopilot_decisions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_outcome_date
  ON public.autopilot_decisions(decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_cooldown
  ON public.autopilot_decisions(account_id, action_type, target_id, created_at DESC)
  WHERE decision = 'executed';

ALTER TABLE public.autopilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopilot_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_settings_owner_select ON public.autopilot_settings;
CREATE POLICY autopilot_settings_owner_select ON public.autopilot_settings
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

DROP POLICY IF EXISTS autopilot_decisions_owner_select ON public.autopilot_decisions;
CREATE POLICY autopilot_decisions_owner_select ON public.autopilot_decisions
  FOR SELECT TO authenticated USING (account_id IN (
    SELECT id FROM public.google_ads_accounts
    WHERE business_id IN (
      SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())
    )
  ));

REVOKE ALL ON TABLE public.autopilot_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.autopilot_decisions FROM anon, authenticated;
GRANT SELECT ON TABLE public.autopilot_settings TO authenticated;
GRANT SELECT ON TABLE public.autopilot_decisions TO authenticated;

COMMENT ON TABLE public.autopilot_settings IS
  'Per-account opt-in policy. New and missing rows are always treated as mode=off.';
COMMENT ON TABLE public.autopilot_decisions IS
  'Append-only evidence ledger for every autopilot proposal, block, validation and execution.';

-- CREATE TABLE IF NOT EXISTS does not update an existing CHECK constraint.
-- Keep reruns safe when this migration was partially applied during rollout.
ALTER TABLE public.autopilot_decisions
  DROP CONSTRAINT IF EXISTS autopilot_decisions_decision_check;
ALTER TABLE public.autopilot_decisions
  ADD CONSTRAINT autopilot_decisions_decision_check
  CHECK (decision IN ('settings_changed', 'observed', 'queued', 'executed', 'unverified', 'blocked', 'failed', 'no_action'));

-- The first release deliberately keeps these safety limits narrow. Recreate
-- the constraints on rerun so a partially applied draft cannot retain wider
-- bounds.
UPDATE public.autopilot_settings
SET
  allowed_actions = ARRAY['add_negative_keyword']::TEXT[],
  max_daily_changes = LEAST(3, GREATEST(1, max_daily_changes)),
  min_confidence = LEAST(1.000, GREATEST(0.950, min_confidence)),
  cooldown_hours = LEAST(168, GREATEST(24, cooldown_hours)),
  require_healthy_tracking = TRUE,
  anomaly_pause_enabled = TRUE
WHERE
  allowed_actions IS DISTINCT FROM ARRAY['add_negative_keyword']::TEXT[]
  OR max_daily_changes NOT BETWEEN 1 AND 3
  OR min_confidence NOT BETWEEN 0.950 AND 1.000
  OR cooldown_hours NOT BETWEEN 24 AND 168
  OR require_healthy_tracking IS DISTINCT FROM TRUE
  OR anomaly_pause_enabled IS DISTINCT FROM TRUE;

ALTER TABLE public.autopilot_settings
  DROP CONSTRAINT IF EXISTS autopilot_settings_max_daily_changes_check,
  DROP CONSTRAINT IF EXISTS autopilot_settings_min_confidence_check,
  DROP CONSTRAINT IF EXISTS autopilot_settings_cooldown_hours_check;
ALTER TABLE public.autopilot_settings
  ADD CONSTRAINT autopilot_settings_max_daily_changes_check
    CHECK (max_daily_changes BETWEEN 1 AND 3),
  ADD CONSTRAINT autopilot_settings_min_confidence_check
    CHECK (min_confidence BETWEEN 0.950 AND 1.000),
  ADD CONSTRAINT autopilot_settings_cooldown_hours_check
    CHECK (cooldown_hours BETWEEN 24 AND 168);

-- Save the policy and its audit entry in the same transaction. The browser
-- role cannot call this function; the route first proves account ownership,
-- then invokes it with the service role.
CREATE OR REPLACE FUNCTION public.save_autopilot_settings(
  p_account_id UUID,
  p_settings JSONB,
  p_previous JSONB,
  p_policy_version TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode TEXT := COALESCE(p_settings->>'mode', 'off');
  v_reason_ar TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.google_ads_accounts
    WHERE id = p_account_id AND status = 'active' AND COALESCE(is_manager, FALSE) = FALSE
  ) THEN
    RAISE EXCEPTION 'active non-manager account required';
  END IF;

  INSERT INTO public.autopilot_settings AS settings (
    account_id,
    mode,
    allowed_actions,
    max_daily_changes,
    min_confidence,
    cooldown_hours,
    require_healthy_tracking,
    anomaly_pause_enabled,
    config_version,
    terms_accepted_at,
    paused_at,
    pause_reason,
    updated_at
  ) VALUES (
    p_account_id,
    v_mode,
    ARRAY['add_negative_keyword']::TEXT[],
    (p_settings->>'max_daily_changes')::INTEGER,
    (p_settings->>'min_confidence')::NUMERIC,
    (p_settings->>'cooldown_hours')::INTEGER,
    TRUE,
    TRUE,
    (p_settings->>'config_version')::INTEGER,
    NULLIF(p_settings->>'terms_accepted_at', '')::TIMESTAMPTZ,
    NULLIF(p_settings->>'paused_at', '')::TIMESTAMPTZ,
    NULLIF(p_settings->>'pause_reason', ''),
    COALESCE(NULLIF(p_settings->>'updated_at', '')::TIMESTAMPTZ, NOW())
  )
  ON CONFLICT (account_id) DO UPDATE SET
    mode = EXCLUDED.mode,
    allowed_actions = EXCLUDED.allowed_actions,
    max_daily_changes = EXCLUDED.max_daily_changes,
    min_confidence = EXCLUDED.min_confidence,
    cooldown_hours = EXCLUDED.cooldown_hours,
    require_healthy_tracking = EXCLUDED.require_healthy_tracking,
    anomaly_pause_enabled = EXCLUDED.anomaly_pause_enabled,
    config_version = EXCLUDED.config_version,
    terms_accepted_at = EXCLUDED.terms_accepted_at,
    paused_at = EXCLUDED.paused_at,
    pause_reason = EXCLUDED.pause_reason,
    updated_at = EXCLUDED.updated_at;

  v_reason_ar := CASE v_mode
    WHEN 'off' THEN 'أوقف المستخدم الطيار الآلي لهذا الحساب.'
    WHEN 'observe' THEN 'فعّل المستخدم وضع المراقبة دون تنفيذ تلقائي.'
    WHEN 'conservative' THEN 'فعّل المستخدم التنفيذ المحافظ ضمن الحدود المعتمدة.'
    ELSE 'غيّر المستخدم إعدادات الطيار الآلي.'
  END;

  INSERT INTO public.autopilot_decisions (
    account_id,
    mode,
    decision,
    policy_version,
    reason_ar,
    action_snapshot
  ) VALUES (
    p_account_id,
    v_mode,
    'settings_changed',
    p_policy_version,
    v_reason_ar,
    JSONB_BUILD_OBJECT(
      'previous', COALESCE(p_previous, '{}'::JSONB),
      'next', p_settings
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_autopilot_settings(UUID, JSONB, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_autopilot_settings(UUID, JSONB, JSONB, TEXT)
  TO service_role;
