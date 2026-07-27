-- =====================================================================
-- Launch hardening — 2026-07-26
--
-- 1. Billing tables become read-only for browser clients. `FOR ALL` with
--    no WITH CHECK let any authenticated user INSERT/UPDATE their own
--    subscription row and grant themselves a paid plan for free, and
--    forge or delete invoices. Only the service role writes these.
-- 2. Append-only logs (ai_actions / audits / reports) lose DELETE (and
--    UPDATE where unused) so the guardrail history cannot be erased.
-- 3. One business per user, enforced in the database, so a double submit
--    can no longer strand a returning user's linked accounts under an
--    orphan business (the "sent back to onboarding" bug).
-- 4. Google Ads account rows learn whether they are managers and what
--    Google reports their status as, so metrics are never requested for
--    an MCC.
-- 5. Trial ledger that survives account deletion (unlimited-free-trial
--    loop), subscription event ordering, missing indexes, and a pinned
--    search_path on the auth trigger.
--
-- Forward-only. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Billing tables: SELECT-only for anon/authenticated
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS subs_owner_only ON public.subscriptions;
DROP POLICY IF EXISTS subs_owner_select ON public.subscriptions;
CREATE POLICY subs_owner_select ON public.subscriptions
  FOR SELECT USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.subscriptions FROM anon, authenticated;

DROP POLICY IF EXISTS invoices_owner_only ON public.invoices;
DROP POLICY IF EXISTS invoices_owner_select ON public.invoices;
CREATE POLICY invoices_owner_select ON public.invoices
  FOR SELECT USING (user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.invoices FROM anon, authenticated;

-- Trial grants are written exclusively by the Stripe webhook / checkout
-- completion handler with the service role.
REVOKE INSERT, UPDATE, DELETE ON public.billing_trial_grants FROM anon, authenticated;

-- Usage metering rows are created through consume_feature_usage()
-- (SECURITY DEFINER). Nothing should ever rewrite or erase them.
REVOKE UPDATE, DELETE ON public.usage_events FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) Append-only execution history
-- ---------------------------------------------------------------------

-- ai_actions still needs UPDATE (rollback state machine) but never DELETE:
-- the 24h cumulative budget guardrail is computed by summing these rows.
REVOKE DELETE ON public.ai_actions FROM anon, authenticated;

-- audits and reports are inserted once and never modified by a client.
REVOKE UPDATE, DELETE ON public.audits FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.reports FROM anon, authenticated;

-- recommendations move through a status machine (pending → approved →
-- executing → applied) so UPDATE stays, DELETE goes.
REVOKE DELETE ON public.recommendations FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) One business per user (merge duplicates, then constrain)
-- ---------------------------------------------------------------------

DO $$
DECLARE
  duplicate_users INT;
BEGIN
  SELECT COUNT(*) INTO duplicate_users
  FROM (SELECT user_id FROM public.businesses GROUP BY user_id HAVING COUNT(*) > 1) d;

  IF duplicate_users > 0 THEN
    RAISE NOTICE 'Merging duplicate businesses for % user(s)', duplicate_users;

    CREATE TEMP TABLE _canonical_business ON COMMIT DROP AS
    SELECT DISTINCT ON (user_id) user_id, id AS keep_id
    FROM public.businesses
    ORDER BY user_id, created_at DESC, id DESC;

    -- (a) Move ad accounts that do not collide with the canonical business.
    UPDATE public.google_ads_accounts g
    SET business_id = c.keep_id
    FROM public.businesses b
    JOIN _canonical_business c ON c.user_id = b.user_id
    WHERE g.business_id = b.id
      AND b.id <> c.keep_id
      AND NOT EXISTS (
        SELECT 1 FROM public.google_ads_accounts g2
        WHERE g2.business_id = c.keep_id AND g2.customer_id = g.customer_id
      );

    -- (b) For colliding customer ids, re-point the history onto the
    --     surviving account row before the duplicate is removed.
    CREATE TEMP TABLE _dup_accounts ON COMMIT DROP AS
    SELECT g.id AS dup_id, keep.id AS keep_id
    FROM public.google_ads_accounts g
    JOIN public.businesses b ON b.id = g.business_id
    JOIN _canonical_business c ON c.user_id = b.user_id
    JOIN public.google_ads_accounts keep
      ON keep.business_id = c.keep_id AND keep.customer_id = g.customer_id
    WHERE b.id <> c.keep_id;

    UPDATE public.audits a SET account_id = d.keep_id
      FROM _dup_accounts d WHERE a.account_id = d.dup_id;
    UPDATE public.recommendations r SET account_id = d.keep_id
      FROM _dup_accounts d WHERE r.account_id = d.dup_id;
    UPDATE public.ai_actions ac SET account_id = d.keep_id
      FROM _dup_accounts d WHERE ac.account_id = d.dup_id;
    UPDATE public.reports rp SET account_id = d.keep_id
      FROM _dup_accounts d WHERE rp.account_id = d.dup_id;
    UPDATE public.chat_sessions cs SET account_id = d.keep_id
      FROM _dup_accounts d WHERE cs.account_id = d.dup_id;
    UPDATE public.usage_events ue SET account_id = d.keep_id
      FROM _dup_accounts d WHERE ue.account_id = d.dup_id;

    -- campaigns_cache is a rebuildable mirror; drop the duplicate rows.
    DELETE FROM public.campaigns_cache cc USING _dup_accounts d
      WHERE cc.account_id = d.dup_id;

    DELETE FROM public.google_ads_accounts g USING _dup_accounts d
      WHERE g.id = d.dup_id;

    -- (c) Remove the now-empty duplicate businesses.
    DELETE FROM public.businesses b
    USING _canonical_business c
    WHERE b.user_id = c.user_id
      AND b.id <> c.keep_id
      AND NOT EXISTS (SELECT 1 FROM public.google_ads_accounts g WHERE g.business_id = b.id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_user_id_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM (SELECT user_id FROM public.businesses GROUP BY user_id HAVING COUNT(*) > 1) d
  ) THEN
    ALTER TABLE public.businesses ADD CONSTRAINT businesses_user_id_key UNIQUE (user_id);
  ELSIF EXISTS (
    SELECT 1 FROM (SELECT user_id FROM public.businesses GROUP BY user_id HAVING COUNT(*) > 1) d
  ) THEN
    RAISE WARNING 'businesses still has duplicates per user; unique constraint not added. Resolve manually.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4) Google Ads account metadata needed to keep metrics off managers
-- ---------------------------------------------------------------------

ALTER TABLE public.google_ads_accounts
  ADD COLUMN IF NOT EXISTS is_manager BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.google_ads_accounts
  ADD COLUMN IF NOT EXISTS google_status TEXT;

ALTER TABLE public.google_ads_accounts
  ADD COLUMN IF NOT EXISTS name_repair_attempted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gads_business_selectable
  ON public.google_ads_accounts(business_id, is_manager, status);

-- ---------------------------------------------------------------------
-- 5) Billing correctness: event ordering + a trial ledger that survives
--    account deletion
-- ---------------------------------------------------------------------

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;

-- Deleting an account cascades billing_trial_grants away, which let the
-- same person delete and re-register for an unlimited number of free
-- 14-day trials. This ledger is keyed on a hash of the email and is
-- never deleted. Service role only (RLS on, no policy).
CREATE TABLE IF NOT EXISTS public.billing_trial_ledger (
  email_hash TEXT PRIMARY KEY,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT
);

ALTER TABLE public.billing_trial_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_trial_ledger FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'invoices_user_number_uniq') THEN
    -- Collapse any pre-existing duplicates first so the index can be built.
    DELETE FROM public.invoices a
    USING public.invoices b
    WHERE a.user_id = b.user_id
      AND a.invoice_number IS NOT NULL
      AND a.invoice_number = b.invoice_number
      AND a.ctid > b.ctid;

    CREATE UNIQUE INDEX invoices_user_number_uniq
      ON public.invoices (user_id, invoice_number)
      WHERE invoice_number IS NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6) Missing indexes on user-scoped hot paths
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON public.chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_account ON public.chat_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON public.invoices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_subscription ON public.invoices(subscription_id);
CREATE INDEX IF NOT EXISTS idx_recs_audit ON public.recommendations(audit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_account_synced ON public.campaigns_cache(account_id, last_synced_at DESC);

-- ---------------------------------------------------------------------
-- 7) Pin search_path on the SECURITY DEFINER auth trigger
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_auth_user'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.handle_new_auth_user() SET search_path = public, pg_temp';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8) Migration ledger must not be readable or writable through PostgREST
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_modaafa_migrations') THEN
    EXECUTE 'ALTER TABLE public._modaafa_migrations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public._modaafa_migrations FROM anon, authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 9) Invoice currency
--
-- `amount_sar` was written as `amount_paid / 100` regardless of the
-- invoice's actual currency and rendered with a SAR formatter, so a USD
-- invoice was shown to the customer as riyals. Store what Stripe reports.
-- ---------------------------------------------------------------------

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'SAR';

-- ---------------------------------------------------------------------
-- 10) Deterministic chat message ordering
--
-- The user turn and the assistant turn are inserted in one statement, so
-- both carry the same transaction `now()`. Ordering by created_at made
-- every turn a tie, and replaying history could put an answer before its
-- question (or cut a turn in half at the LIMIT boundary).
-- ---------------------------------------------------------------------

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq
  ON public.chat_messages(session_id, seq);
