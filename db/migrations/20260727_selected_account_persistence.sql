-- =====================================================================
-- Persist the user's selected Google Ads account across sign-out/devices.
--
-- The httpOnly selection cookie is deliberately cleared at sign-out to
-- prevent account context leaking between users on a shared browser. This
-- preference belongs to the authenticated user's single business instead.
--
-- Forward-only. Safe to re-run.
-- =====================================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS selected_google_ads_customer_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'businesses_selected_google_ads_customer_id_format'
      AND conrelid = 'public.businesses'::regclass
  ) THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_selected_google_ads_customer_id_format
      CHECK (
        selected_google_ads_customer_id IS NULL
        OR selected_google_ads_customer_id ~ '^[0-9]{10}$'
      );
  END IF;
END $$;
