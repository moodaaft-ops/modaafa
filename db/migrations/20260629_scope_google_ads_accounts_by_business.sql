-- Allow the same Google Ads customer to be linked by different Modaafa businesses.
-- A SaaS account must own links by business_id, not globally by customer_id.

ALTER TABLE google_ads_accounts
  DROP CONSTRAINT IF EXISTS google_ads_accounts_customer_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'google_ads_accounts_business_id_customer_id_key'
  ) THEN
    ALTER TABLE google_ads_accounts
      ADD CONSTRAINT google_ads_accounts_business_id_customer_id_key
      UNIQUE (business_id, customer_id);
  END IF;
END $$;
