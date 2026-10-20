CREATE TABLE IF NOT EXISTS public.merchant_call_phones (
 business_id UUID PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
 phone_e164 TEXT NOT NULL CHECK (phone_e164 ~ '^\+9665[0-9]{8}$'),
 confirmed_by UUID NOT NULL REFERENCES auth.users(id),
 confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.merchant_call_phones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_call_phones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.merchant_call_phones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_call_phones TO service_role;
DROP POLICY IF EXISTS merchant_call_phones_owner_read ON public.merchant_call_phones;
CREATE POLICY merchant_call_phones_owner_read ON public.merchant_call_phones FOR SELECT TO authenticated
 USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = (SELECT auth.uid())));
