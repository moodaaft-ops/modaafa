-- Forward-only: allow metered background work without impersonating a user.
-- Browser calls retain their own-user check and cannot refund usage.
BEGIN;

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
  IF p_user_id IS NULL OR (
    auth.role() IS DISTINCT FROM 'service_role' AND auth.uid() IS DISTINCT FROM p_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_window_start IS NULL OR p_window_end IS NULL
    OR p_window_end <= p_window_start THEN
    RAISE EXCEPTION 'invalid usage window';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_feature || ':' || p_window_start::text, 0)
  );
  SELECT COUNT(*)::integer INTO v_used
  FROM public.usage_events
  WHERE user_id = p_user_id AND feature = p_feature
    AND created_at >= p_window_start AND created_at < p_window_end;
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

REVOKE ALL ON FUNCTION public.consume_feature_usage(UUID, TEXT, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_feature_usage(UUID, TEXT, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, JSONB)
  TO authenticated, service_role;

COMMIT;
