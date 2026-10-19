-- =====================================================================
-- Partner (affiliate) programme - 2026-10-19
--
-- RUN AFTER 20261013_trial_abuse_guards.sql (public.trial_email_key) and the
-- core schema (users, subscriptions, invoices). Nothing here is read by the app
-- until PARTNERS_ENABLED is switched on in Vercel, so running it first changes
-- no behaviour.
--
--   1. partner_settings      one row of programme numbers (rates, hold, minimum)
--   2. partners              who may earn, with an optional per-partner override
--   3. referral_clicks       one row per visitor per day per partner (hashed)
--   4. referrals             one referrer per referred user; locks at first payment
--   5. payouts / commissions money owed and money paid; commissions are keyed on
--                            the SAME invoice key as public.invoices.invoice_number
--                            (Stripe `number ?? id`), so a webhook retry and the
--                            reconcile sweep can never earn the same invoice twice
--   6. functions             record click / record referral / accrue / void / pay
--                            out / reconcile. All service_role only.
--   7. partner_skipped_invoices  invoices that must never earn (refunded before
--                            the commission existed, outside the window)
--
-- Privileges: every table is service_role only (RLS on, nothing granted to
-- anon or authenticated). The partner dashboard reads through the server with
-- the signed-in user's id, never straight from the browser.
--
-- Idempotent and additive: safe to run twice.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.invoices') IS NULL
     OR to_regclass('public.subscriptions') IS NULL THEN
    RAISE EXCEPTION 'users / subscriptions / invoices are missing. Apply the core schema first.';
  END IF;
  IF to_regprocedure('public.trial_email_key(text)') IS NULL THEN
    RAISE EXCEPTION 'public.trial_email_key is missing. Run 20261013_trial_abuse_guards.sql first.';
  END IF;
END $$;

-- 1. Settings ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Proposed numbers, not measured ones. Change them with one UPDATE; nothing is
  -- compiled into the app.
  default_rate numeric(5,4) NOT NULL DEFAULT 0.25 CHECK (default_rate BETWEEN 0 AND 0.5),
  tier_rate numeric(5,4) NOT NULL DEFAULT 0.30 CHECK (tier_rate BETWEEN 0 AND 0.5),
  -- The higher rate applies when MORE than this many referred customers are
  -- paying (subscription active) at the moment an invoice is earned.
  tier_threshold int NOT NULL DEFAULT 10 CHECK (tier_threshold >= 0),
  commission_months int NOT NULL DEFAULT 12 CHECK (commission_months BETWEEN 1 AND 36),
  hold_days int NOT NULL DEFAULT 30 CHECK (hold_days BETWEEN 0 AND 120),
  min_payout numeric(10,2) NOT NULL DEFAULT 300 CHECK (min_payout >= 0),
  -- More first payments than this inside seven days holds the commissions for review.
  velocity_cap int NOT NULL DEFAULT 5 CHECK (velocity_cap >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.partner_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- 2. Partners ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The partner's own platform account: where they sign in to see their numbers,
  -- and how self-referral is caught. Null until they have registered.
  user_id uuid UNIQUE REFERENCES public.users (id) ON DELETE SET NULL,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 80),
  email text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'paused', 'banned')),
  commission_rate numeric(5,4) CHECK (commission_rate IS NULL OR commission_rate BETWEEN 0 AND 0.5),
  commission_months int CHECK (commission_months IS NULL OR commission_months BETWEEN 1 AND 36),
  payout_method text CHECK (payout_method IS NULL OR payout_method IN ('bank_transfer', 'wise', 'stripe_connect', 'other')),
  payout_details text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS partners_email_uniq ON public.partners (lower(email));

-- 3. Clicks -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referral_clicks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES public.partners (id) ON DELETE CASCADE,
  click_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
  clicked_at timestamptz NOT NULL DEFAULT now(),
  landing_path text,
  -- sha256 of (day, ip, user agent, pepper) computed by the app. The address
  -- itself is never stored. One row per visitor per day per partner.
  visitor_hash text NOT NULL CHECK (char_length(visitor_hash) BETWEEN 16 AND 128),
  UNIQUE (partner_id, visitor_hash, click_day)
);
CREATE INDEX IF NOT EXISTS referral_clicks_partner_idx ON public.referral_clicks (partner_id, clicked_at DESC);

-- 4. Referrals --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners (id) ON DELETE RESTRICT,
  referred_user_id uuid NOT NULL UNIQUE REFERENCES public.users (id) ON DELETE CASCADE,
  code_used text NOT NULL,
  via text NOT NULL CHECK (via IN ('link', 'code', 'ops')),
  attributed_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the first earned invoice. From then on the referrer cannot change.
  first_paid_at timestamptz,
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'paying', 'rejected')),
  flags text[] NOT NULL DEFAULT '{}',
  rejected_reason text
);
CREATE INDEX IF NOT EXISTS referrals_partner_idx ON public.referrals (partner_id, attributed_at DESC);

-- 5. Payouts and commissions -----------------------------------------
CREATE TABLE IF NOT EXISTS public.payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners (id) ON DELETE RESTRICT,
  currency text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text,
  reference text,
  note text,
  paid_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payouts_partner_idx ON public.payouts (partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners (id) ON DELETE RESTRICT,
  referral_id uuid NOT NULL REFERENCES public.referrals (id) ON DELETE RESTRICT,
  -- Same value as public.invoices.invoice_number for that invoice.
  invoice_key text NOT NULL UNIQUE,
  currency text NOT NULL,
  invoice_net numeric(12,2) NOT NULL CHECK (invoice_net >= 0),
  rate numeric(5,4) NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  -- pending: waiting out the hold, then payable. held: a person must look.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'paid', 'voided')),
  earned_at timestamptz NOT NULL,
  payable_at timestamptz NOT NULL,
  paid_at timestamptz,
  payout_id uuid REFERENCES public.payouts (id),
  note text,
  -- A refund or dispute landed after the commission was paid out: the amount is
  -- netted against the partner's next payout.
  needs_clawback boolean NOT NULL DEFAULT false,
  -- How much of a paid commission is owed back. Null means all of it.
  clawback_amount numeric(12,2) CHECK (clawback_amount IS NULL OR clawback_amount >= 0),
  clawback_payout_id uuid REFERENCES public.payouts (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commissions_partner_idx ON public.commissions (partner_id, status, payable_at);
CREATE INDEX IF NOT EXISTS commissions_referral_idx ON public.commissions (referral_id);

-- Invoices that must never earn a commission: refunded or disputed before the
-- commission existed, or outside the window / on a banned partner. One row per
-- invoice key. partner_accrue_commission refuses them and partner_reconcile
-- skips them, so they cannot fill the sweep's batch either.
CREATE TABLE IF NOT EXISTS public.partner_skipped_invoices (
  invoice_key text PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Privileges: service_role only ---------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_settings', 'partners', 'referral_clicks', 'referrals', 'payouts', 'commissions', 'partner_skipped_invoices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

-- 6. Functions --------------------------------------------------------
-- SECURITY DEFINER because public.trial_email_key is not executable by
-- service_role (see 20261013). Each function is executable by service_role only.

-- A click on a partner link. 'unknown' also covers a partner who is not active,
-- so the app sets no cookie for a code that cannot earn.
CREATE OR REPLACE FUNCTION public.partner_record_click(p_code text, p_visitor_hash text, p_path text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_partner_id uuid;
  v_rows int;
BEGIN
  SELECT id INTO v_partner_id FROM partners WHERE code = lower(trim(p_code)) AND status = 'active';
  IF v_partner_id IS NULL THEN RETURN 'unknown'; END IF;
  INSERT INTO referral_clicks (partner_id, visitor_hash, landing_path)
  VALUES (v_partner_id, p_visitor_hash, left(p_path, 200))
  ON CONFLICT (partner_id, visitor_hash, click_day) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN CASE WHEN v_rows = 1 THEN 'recorded' ELSE 'duplicate' END;
END;
$$;

-- Attribute a registered user to a partner. A partner code typed at checkout
-- ('code') replaces a link ('link') until the first payment; after that the
-- referrer is locked.
CREATE OR REPLACE FUNCTION public.partner_record_referral(p_user_id uuid, p_code text, p_via text DEFAULT 'link')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_partner partners%ROWTYPE;
  v_user users%ROWTYPE;
  v_existing referrals%ROWTYPE;
  v_flags text[] := '{}';
  v_rows int;
BEGIN
  IF p_via NOT IN ('link', 'code', 'ops') THEN RETURN 'bad_via'; END IF;

  SELECT * INTO v_user FROM users WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN 'no_user'; END IF;

  SELECT * INTO v_partner FROM partners WHERE code = lower(trim(p_code));
  IF NOT FOUND THEN RETURN 'unknown_code'; END IF;
  IF v_partner.status <> 'active' THEN RETURN 'inactive'; END IF;

  -- Referring yourself: the partner's own account, or the same normalised email.
  IF v_partner.user_id = p_user_id
     OR public.trial_email_key(v_user.email) = public.trial_email_key(v_partner.email) THEN
    RETURN 'self';
  END IF;
  IF v_partner.phone IS NOT NULL AND v_user.phone IS NOT NULL AND v_partner.phone = v_user.phone THEN
    v_flags := array_append(v_flags, 'same_phone');
  END IF;

  SELECT * INTO v_existing FROM referrals WHERE referred_user_id = p_user_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.first_paid_at IS NOT NULL OR v_existing.status = 'rejected' THEN RETURN 'locked'; END IF;
    IF v_existing.partner_id = v_partner.id THEN RETURN 'already'; END IF;
    IF p_via = 'code' OR p_via = 'ops' THEN
      UPDATE referrals
         SET partner_id = v_partner.id, code_used = v_partner.code, via = p_via,
             attributed_at = now(), flags = v_flags
       WHERE id = v_existing.id;
      RETURN 'switched';
    END IF;
    RETURN 'already';
  END IF;

  INSERT INTO referrals (partner_id, referred_user_id, code_used, via, flags)
  VALUES (v_partner.id, p_user_id, v_partner.code, p_via, v_flags)
  ON CONFLICT (referred_user_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN CASE WHEN v_rows = 1 THEN 'recorded' ELSE 'already' END;
END;
$$;

-- Earn a commission from one paid invoice. Idempotent on p_invoice_key. Money
-- is only ever earned here, from an invoice that really moved money.
-- p_force_hold: the caller could not be sure of the amount (the reconcile sweep
-- reads the invoice total, tax included), so a person must look before it is payable.
CREATE OR REPLACE FUNCTION public.partner_accrue_commission(
  p_user_id uuid,
  p_invoice_key text,
  p_net numeric,
  p_currency text,
  p_paid_at timestamptz,
  p_force_hold boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s partner_settings%ROWTYPE;
  v_ref referrals%ROWTYPE;
  v_partner partners%ROWTYPE;
  v_user users%ROWTYPE;
  v_months int;
  v_rate numeric(5,4);
  v_paying int;
  v_amount numeric(12,2);
  v_status text := 'pending';
  v_notes text[] := '{}';
  v_flags text[];
  v_recent int;
  v_velocity boolean := false;
  v_first boolean;
  v_id uuid;
BEGIN
  IF p_invoice_key IS NULL OR btrim(p_invoice_key) = '' THEN RETURN jsonb_build_object('status', 'bad_invoice'); END IF;
  IF p_net IS NULL OR p_net <= 0 THEN RETURN jsonb_build_object('status', 'zero'); END IF;

  SELECT * INTO s FROM partner_settings WHERE singleton;

  -- Lock the referral so two invoices for one customer arriving together are
  -- handled one after the other (first_paid_at is decided under this lock).
  SELECT * INTO v_ref FROM referrals WHERE referred_user_id = p_user_id AND status <> 'rejected' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_referral'); END IF;

  IF EXISTS (SELECT 1 FROM commissions WHERE invoice_key = p_invoice_key) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  IF EXISTS (SELECT 1 FROM partner_skipped_invoices WHERE invoice_key = p_invoice_key) THEN
    RETURN jsonb_build_object('status', 'voided');
  END IF;

  SELECT * INTO v_partner FROM partners WHERE id = v_ref.partner_id;
  IF v_partner.status = 'banned' THEN RETURN jsonb_build_object('status', 'inactive'); END IF;

  v_first := NOT EXISTS (SELECT 1 FROM commissions WHERE referral_id = v_ref.id);
  IF v_ref.first_paid_at IS NULL OR p_paid_at < v_ref.first_paid_at THEN
    UPDATE referrals SET first_paid_at = p_paid_at WHERE id = v_ref.id;
    v_ref.first_paid_at := p_paid_at;
  END IF;

  v_months := COALESCE(v_partner.commission_months, s.commission_months);
  IF p_paid_at > v_ref.first_paid_at + make_interval(months => v_months) THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  -- The rate: the partner's own, else the tier by how many referred customers
  -- are paying right now.
  IF v_partner.commission_rate IS NOT NULL THEN
    v_rate := v_partner.commission_rate;
  ELSE
    SELECT count(DISTINCT sub.user_id) INTO v_paying
      FROM referrals r
      JOIN subscriptions sub ON sub.user_id = r.referred_user_id
     WHERE r.partner_id = v_partner.id AND r.status <> 'rejected' AND sub.status = 'active';
    v_rate := CASE WHEN v_paying > s.tier_threshold THEN s.tier_rate ELSE s.default_rate END;
  END IF;
  v_amount := round(p_net * v_rate, 2);

  -- Checks that put the commission on hold for a person to look at. None of them
  -- rejects the customer: a held commission is simply not payable yet.
  SELECT * INTO v_user FROM users WHERE id = p_user_id;
  v_flags := v_ref.flags;
  IF (public.trial_email_key(v_user.email) = public.trial_email_key(v_partner.email) OR v_partner.user_id = p_user_id)
     AND NOT 'same_email' = ANY (v_flags) THEN
    v_flags := array_append(v_flags, 'same_email');
  END IF;
  IF v_partner.phone IS NOT NULL AND v_user.phone IS NOT NULL AND v_partner.phone = v_user.phone
     AND NOT 'same_phone' = ANY (v_flags) THEN
    v_flags := array_append(v_flags, 'same_phone');
  END IF;
  -- The partner's own card paid for the referred customer's subscription.
  IF v_partner.user_id IS NOT NULL AND to_regclass('public.trial_card_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM trial_card_ledger l
                  JOIN subscriptions sb ON sb.stripe_subscription_id = l.stripe_subscription_id
                 WHERE l.first_user_id = v_partner.user_id AND sb.user_id = p_user_id)
     AND NOT 'same_card' = ANY (v_flags) THEN
    v_flags := array_append(v_flags, 'same_card');
  END IF;

  -- A burst of new customers is judged once, on a customer's FIRST commission.
  -- It is a note on that commission, never a lasting flag on the customer, so
  -- their later renewals are not held for something that happened once.
  IF v_first THEN
    SELECT count(*) INTO v_recent
      FROM referrals r
     WHERE r.partner_id = v_partner.id AND r.id <> v_ref.id
       AND r.first_paid_at > p_paid_at - interval '7 days' AND r.first_paid_at <= p_paid_at;
    v_velocity := v_recent >= s.velocity_cap;
  END IF;

  IF 'same_email' = ANY (v_flags) OR 'same_phone' = ANY (v_flags) OR 'same_card' = ANY (v_flags) THEN
    v_notes := array_append(v_notes, 'flags: ' || array_to_string(v_flags, ','));
    v_status := 'held';
  END IF;
  IF v_velocity THEN v_notes := array_append(v_notes, 'velocity'); v_status := 'held'; END IF;
  IF v_partner.status = 'paused' THEN v_notes := array_append(v_notes, 'partner paused'); v_status := 'held'; END IF;
  IF p_force_hold THEN v_notes := array_append(v_notes, 'reconciled: base is the invoice total, check tax'); v_status := 'held'; END IF;

  INSERT INTO commissions (partner_id, referral_id, invoice_key, currency, invoice_net, rate, amount, status, earned_at, payable_at, note)
  VALUES (v_partner.id, v_ref.id, p_invoice_key, upper(COALESCE(p_currency, 'SAR')), p_net, v_rate, v_amount, v_status,
          p_paid_at, p_paid_at + make_interval(days => s.hold_days),
          CASE WHEN cardinality(v_notes) = 0 THEN NULL ELSE array_to_string(v_notes, '; ') END)
  ON CONFLICT (invoice_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('status', 'duplicate'); END IF;

  UPDATE referrals SET status = 'paying', flags = v_flags WHERE id = v_ref.id;

  RETURN jsonb_build_object('status', 'earned', 'commission_id', v_id, 'partner_id', v_partner.id,
                            'referral_id', v_ref.id, 'amount', v_amount, 'rate', v_rate, 'held', v_status = 'held');
END;
$$;

-- A refund or dispute on an invoice. p_fraction is the share of the invoice that
-- was refunded (1 for a full refund or a dispute). Full: an unpaid commission is
-- voided; a paid one is marked to be netted off the next payout. Partial: the
-- commission is cut pro rata from the original invoice amount (so the same event
-- twice gives the same answer); a paid one is clawed back for the difference.
-- When no commission exists yet, a full refund is remembered so the commission
-- can never be earned later from that invoice.
CREATE OR REPLACE FUNCTION public.partner_void_invoice(p_invoice_key text, p_reason text, p_fraction numeric DEFAULT 1)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c commissions%ROWTYPE;
  v_new numeric(12,2);
  v_f numeric := LEAST(GREATEST(COALESCE(p_fraction, 1), 0), 1);
BEGIN
  IF v_f = 0 THEN RETURN 'nothing'; END IF;
  SELECT * INTO c FROM commissions WHERE invoice_key = p_invoice_key FOR UPDATE;
  IF NOT FOUND THEN
    IF v_f >= 1 THEN
      INSERT INTO partner_skipped_invoices (invoice_key, reason) VALUES (p_invoice_key, left(p_reason, 40)) ON CONFLICT DO NOTHING;
    END IF;
    RETURN 'no_commission';
  END IF;
  IF c.status = 'voided' THEN RETURN 'already'; END IF;

  IF v_f < 1 THEN
    v_new := round(c.invoice_net * (1 - v_f) * c.rate, 2);
    IF c.status = 'paid' THEN
      UPDATE commissions
         SET needs_clawback = true, clawback_amount = GREATEST(c.amount - v_new, 0),
             note = COALESCE(note || '; ', '') || 'partial refund after payout'
       WHERE id = c.id AND clawback_payout_id IS NULL;
      RETURN 'partial_clawback';
    END IF;
    UPDATE commissions
       SET amount = LEAST(amount, v_new), note = COALESCE(note || '; ', '') || 'partial refund, cut pro rata'
     WHERE id = c.id;
    RETURN 'reduced';
  END IF;

  IF c.status = 'paid' THEN
    UPDATE commissions SET needs_clawback = true, clawback_amount = NULL,
           note = COALESCE(note || '; ', '') || left(p_reason, 80) WHERE id = c.id;
    RETURN 'clawback';
  END IF;
  UPDATE commissions SET status = 'voided', note = COALESCE(note || '; ', '') || left(p_reason, 80) WHERE id = c.id;
  RETURN 'voided';
END;
$$;

-- Release or void a held commission (a person decided).
CREATE OR REPLACE FUNCTION public.partner_resolve_held(p_commission_id uuid, p_release boolean, p_note text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE commissions
     SET status = CASE WHEN p_release THEN 'pending' ELSE 'voided' END,
         note = COALESCE(note || '; ', '') || COALESCE(left(p_note, 80), CASE WHEN p_release THEN 'released' ELSE 'voided by ops' END)
   WHERE id = p_commission_id AND status = 'held';
  IF NOT FOUND THEN RETURN 'not_held'; END IF;
  RETURN CASE WHEN p_release THEN 'released' ELSE 'voided' END;
END;
$$;

-- Pay a partner everything that is payable in one currency. The exact rows are
-- locked first and the amount is worked out from those rows, so a refund landing
-- at the same moment either comes first (and is left out) or waits. Clawbacks are
-- netted first. Below the minimum nothing moves. p_expected: the net amount the
-- operator saw and transferred; when it differs from the books now, nothing is
-- recorded and the caller is told the real figure.
CREATE OR REPLACE FUNCTION public.partner_pay_out(
  p_partner_id uuid,
  p_currency text,
  p_method text,
  p_reference text,
  p_note text DEFAULT NULL,
  p_paid_by uuid DEFAULT NULL,
  p_expected numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s partner_settings%ROWTYPE;
  v_cur text := upper(COALESCE(p_currency, 'SAR'));
  v_pay_ids uuid[];
  v_claw_ids uuid[];
  v_gross numeric(12,2);
  v_claw numeric(12,2);
  v_net numeric(12,2);
  v_payout uuid;
BEGIN
  SELECT * INTO s FROM partner_settings WHERE singleton;
  PERFORM 1 FROM partners WHERE id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_partner'); END IF;

  SELECT COALESCE(array_agg(id), '{}'), COALESCE(sum(amount), 0) INTO v_pay_ids, v_gross FROM (
    SELECT id, amount FROM commissions
     WHERE partner_id = p_partner_id AND currency = v_cur AND status = 'pending' AND payable_at <= now()
     ORDER BY id FOR UPDATE
  ) x;
  SELECT COALESCE(array_agg(id), '{}'), COALESCE(sum(COALESCE(clawback_amount, amount)), 0) INTO v_claw_ids, v_claw FROM (
    SELECT id, amount, clawback_amount FROM commissions
     WHERE partner_id = p_partner_id AND currency = v_cur AND needs_clawback AND clawback_payout_id IS NULL
     ORDER BY id FOR UPDATE
  ) y;
  v_net := v_gross - v_claw;

  IF v_gross = 0 THEN RETURN jsonb_build_object('status', 'nothing'); END IF;
  IF p_expected IS NOT NULL AND abs(p_expected - v_net) > 0.005 THEN
    RETURN jsonb_build_object('status', 'amount_changed', 'net', v_net, 'expected', p_expected);
  END IF;
  IF v_net <= 0 THEN RETURN jsonb_build_object('status', 'covered_by_clawback', 'gross', v_gross, 'clawback', v_claw); END IF;
  IF v_cur = 'SAR' AND v_net < s.min_payout THEN
    RETURN jsonb_build_object('status', 'below_minimum', 'net', v_net, 'minimum', s.min_payout);
  END IF;

  INSERT INTO payouts (partner_id, currency, amount, method, reference, note, paid_by)
  VALUES (p_partner_id, v_cur, v_net, p_method, p_reference, p_note, p_paid_by)
  RETURNING id INTO v_payout;

  UPDATE commissions SET status = 'paid', paid_at = now(), payout_id = v_payout WHERE id = ANY (v_pay_ids);
  UPDATE commissions SET clawback_payout_id = v_payout WHERE id = ANY (v_claw_ids);

  RETURN jsonb_build_object('status', 'paid', 'payout_id', v_payout, 'amount', v_net, 'gross', v_gross, 'clawback', v_claw);
END;
$$;

-- The safety net behind the webhook: any paid invoice of a referred customer that
-- has no commission yet is earned now. Invoices carry the same key, so running it
-- twice, or racing the webhook, changes nothing. The invoice row holds the total
-- paid (tax included), so what this earns is HELD for a person to confirm.
-- Invoices that cannot earn (outside the window, banned partner) are remembered,
-- so they never fill a batch again.
CREATE OR REPLACE FUNCTION public.partner_reconcile(p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_res jsonb;
  v_earned int := 0;
  v_seen int := 0;
BEGIN
  FOR r IN
    SELECT i.user_id, i.invoice_number, i.amount_sar, i.currency, COALESCE(i.paid_at, i.created_at) AS paid_at
      FROM invoices i
      JOIN referrals rf ON rf.referred_user_id = i.user_id AND rf.status <> 'rejected'
     WHERE i.status = 'paid' AND i.amount_sar > 0 AND i.invoice_number IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM commissions c WHERE c.invoice_key = i.invoice_number)
       AND NOT EXISTS (SELECT 1 FROM partner_skipped_invoices k WHERE k.invoice_key = i.invoice_number)
     ORDER BY COALESCE(i.paid_at, i.created_at)
     LIMIT p_limit
  LOOP
    v_seen := v_seen + 1;
    v_res := public.partner_accrue_commission(r.user_id, r.invoice_number, r.amount_sar, r.currency, r.paid_at, true);
    IF v_res ->> 'status' = 'earned' THEN v_earned := v_earned + 1; END IF;
    IF v_res ->> 'status' IN ('expired', 'inactive') THEN
      INSERT INTO partner_skipped_invoices (invoice_key, reason) VALUES (r.invoice_number, v_res ->> 'status') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_seen, 'earned', v_earned);
END;
$$;

-- Functions are service_role only.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'partner_record_click(text,text,text)',
    'partner_record_referral(uuid,text,text)',
    'partner_accrue_commission(uuid,text,numeric,text,timestamptz,boolean)',
    'partner_void_invoice(text,text,numeric)',
    'partner_resolve_held(uuid,boolean,text)',
    'partner_pay_out(uuid,text,text,text,text,uuid,numeric)',
    'partner_reconcile(int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
