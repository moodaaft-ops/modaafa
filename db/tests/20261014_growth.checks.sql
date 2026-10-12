-- Checks for 20261014_user_onboarding_answers.sql and 20261014_visitor_leads.sql.
-- Run on a scratch Postgres, never on production. Needs the roles anon,
-- authenticated and service_role (service_role with BYPASSRLS, as in Supabase)
-- and a public.users table. Every statement after "must fail" is expected to be
-- refused; the comment says by which constraint.

-- Grants: service_role only, no policies.
select grantee, privilege_type from information_schema.role_table_grants
 where table_name in ('user_onboarding_answers', 'visitor_leads') and grantee in ('anon', 'authenticated', 'public');   -- 0 rows
select relname, relrowsecurity from pg_class where relname in ('user_onboarding_answers', 'visitor_leads');           -- both true

-- Works as service_role:
--   insert into public.visitor_leads (channel, email) values ('email', 'a@b.com');
--   insert into public.visitor_leads (channel, whatsapp) values ('whatsapp', '966501234567');
--   select public.claim_lead_followup(id) from public.visitor_leads where channel = 'email';   -- t, then f
--   select public.claim_lead_followup(id) from public.visitor_leads where channel = 'whatsapp'; -- f (never emailed)

-- Must fail:
--   same email twice                         -> unique constraint "visitor_leads_email_once"
--   email and whatsapp in one row            -> check "visitor_leads_one_contact"
--   email with capital letters               -> check "visitor_leads_email_check"
--   whatsapp '12'                            -> check "visitor_leads_whatsapp_check"
--   answers for a user that does not exist   -> foreign key "user_onboarding_answers_user_id_fkey"
--   business_type 'x'                        -> check "user_onboarding_answers_business_type_check"
--   skipped = true with an answer filled in  -> check "onboarding_answers_all_or_skipped"
--   claim after 3 attempts                   -> false
