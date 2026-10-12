-- Visitors who left an email or WhatsApp number in the landing page's exit
-- popup (they have NOT signed up) - 2026-10-14
--
-- Why a table of its own: public.message_log and public.claim_message belong to
-- signed-up users (user_id is a foreign key to public.users). A visitor has no
-- user row, so the "never twice" claim for a lead lives here, with the same
-- shape: one atomic UPDATE decides who may send.
--
-- Contact rules enforced by the database, not only by the app:
--   * exactly one way to reach the person (email OR WhatsApp number)
--   * the same email or number is stored once, so a repeat submit changes nothing
--   * WhatsApp is never sent from the server: 'whatsapp' leads become a
--     follow-up list in /operations that Ayman works through by hand
--
-- Server-only: RLS on, no policies, every privilege revoked from public, anon,
-- authenticated and service_role, then the minimum granted to service_role.
--
-- Additive only. NOT applied to production by the PR that adds it: Ayman runs
-- it. Until then POST /api/leads answers 503 and the popup tells the visitor to
-- try again later, so nothing is lost silently.

begin;

create table if not exists public.visitor_leads (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email', 'whatsapp')),
  -- lowercased, trimmed
  email text check (email is null or (char_length(email) between 5 and 254 and email = lower(email))),
  -- The mailbox behind the address (no +tag, no gmail dots). One row per mailbox,
  -- so name+1@x, name+2@x and n.ame@gmail.com cannot be used to flood one inbox.
  email_key text,
  -- digits only with country code, e.g. 9665XXXXXXXX
  whatsapp text check (whatsapp is null or whatsapp ~ '^[0-9]{10,15}$'),
  -- where the popup fired
  source text not null default 'exit_desktop' check (source in ('exit_desktop', 'exit_mobile')),
  -- landing page path and any utm_* the visitor arrived with (short strings only)
  page text not null default '/' check (char_length(page) <= 200),
  utm jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  -- Email follow-up (sent by the app through Resend)
  followup_status text not null default 'pending'
    check (followup_status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  followup_attempts int not null default 0,
  followup_updated_at timestamptz not null default now(),
  followup_sent_at timestamptz,
  followup_provider_id text,
  followup_reason text,

  -- WhatsApp follow-up (done by hand from /operations)
  whatsapp_status text not null default 'pending'
    check (whatsapp_status in ('pending', 'contacted', 'dismissed')),
  contacted_at timestamptz,
  contacted_by text,

  messages_opt_out boolean not null default false,
  messages_opt_out_at timestamptz,

  constraint visitor_leads_one_contact check (
    (channel = 'email' and email is not null and email_key is not null and whatsapp is null)
    or (channel = 'whatsapp' and whatsapp is not null and email is null)
  )
);

create unique index if not exists visitor_leads_email_once on public.visitor_leads (email_key) where email_key is not null;
create unique index if not exists visitor_leads_whatsapp_once on public.visitor_leads (whatsapp) where whatsapp is not null;
create index if not exists visitor_leads_created_idx on public.visitor_leads (created_at desc);
create index if not exists visitor_leads_followup_idx on public.visitor_leads (followup_status, created_at);

-- claim_lead_followup -----------------------------------------------------
-- Returns true only for the caller that wins the right to email this lead.
-- Same rule as claim_message: a fresh row, a failed row with fewer than 3
-- attempts, or a 'sending' claim older than 10 minutes (the process died
-- between claiming and recording the outcome).
create or replace function public.claim_lead_followup(p_lead_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.visitor_leads
     set followup_status = 'sending',
         followup_attempts = followup_attempts + 1,
         followup_updated_at = now()
   where id = p_lead_id
     and channel = 'email'
     and messages_opt_out = false
     and followup_attempts < 3
     and (
       followup_status in ('pending', 'failed')
       or (followup_status = 'sending' and followup_updated_at < now() - interval '10 minutes')
     )
  returning id into v_id;

  return v_id is not null;
end;
$$;

alter table public.visitor_leads enable row level security;
revoke all on table public.visitor_leads from public, anon, authenticated, service_role;
grant select, insert, update on table public.visitor_leads to service_role;

revoke all on function public.claim_lead_followup(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_lead_followup(uuid) to service_role;

commit;

-- Verification (run manually after applying):
--   select count(*) from public.visitor_leads;                      -- 0
--   select indexname from pg_indexes where tablename = 'visitor_leads';
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'visitor_leads';                            -- service_role only
