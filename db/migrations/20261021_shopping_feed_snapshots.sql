CREATE TABLE IF NOT EXISTS public.shopping_feed_snapshots (
 account_id UUID NOT NULL REFERENCES public.google_ads_accounts(id) ON DELETE CASCADE,
 snapshot_date DATE NOT NULL,
 summary JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(account_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_shopping_feed_snapshot_date ON public.shopping_feed_snapshots(snapshot_date);
ALTER TABLE public.shopping_feed_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shopping_feed_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shopping_feed_snapshots TO authenticated;
GRANT ALL ON public.shopping_feed_snapshots TO service_role;
DROP POLICY IF EXISTS shopping_feed_snapshots_owner_read ON public.shopping_feed_snapshots;
CREATE POLICY shopping_feed_snapshots_owner_read ON public.shopping_feed_snapshots FOR SELECT TO authenticated
 USING (account_id IN (SELECT a.id FROM public.google_ads_accounts a JOIN public.businesses b ON b.id=a.business_id WHERE b.user_id=(SELECT auth.uid())));
