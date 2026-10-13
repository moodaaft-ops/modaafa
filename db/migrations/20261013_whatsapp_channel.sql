-- =============================================================================
-- 2026-10-13 - WhatsApp channel (Cloud API): event ledger and consent columns
--
-- whatsapp_events keeps every inbound message and every delivery status the
-- webhook receives. (wamid, event_key) is unique because Meta redelivers
-- webhooks that were not answered with 200, and a duplicate must be absorbed
-- rather than stored twice.
--
-- users gets two consent timestamps. Nothing is sent to a user whose
-- whatsapp_opt_in_at is empty, and a stop reply sets whatsapp_opt_out_at.
--
-- Forward-only, non-destructive and safe to run repeatedly.
-- Server-only data: RLS is enabled with NO policies, anon and authenticated
-- hold no privilege, and only the service role reads and appends.
--
-- Supabase gives new objects in schema public default privileges for anon,
-- authenticated and service_role, so this file first revokes everything on
-- what it creates and then grants back the minimum.
-- =============================================================================

begin;

alter table public.users
  add column if not exists whatsapp_opt_in_at timestamptz,
  add column if not exists whatsapp_opt_out_at timestamptz;

create table if not exists public.whatsapp_events (
  id uuid primary key default gen_random_uuid(),
  wamid text not null check (char_length(wamid) <= 200),
  -- 'message' for an inbound message, otherwise the delivery status.
  event_key text not null check (event_key in ('message', 'sent', 'delivered', 'read', 'failed')),
  -- The other party's WhatsApp id: digits with country code, no plus.
  wa_id text not null check (wa_id ~ '^[1-9][0-9]{7,14}$'),
  user_id uuid references public.users(id) on delete set null,
  kind text check (kind is null or char_length(kind) <= 40),
  body text check (body is null or char_length(body) <= 4096),
  error_code integer,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  constraint whatsapp_events_wamid_event_key_key unique (wamid, event_key)
);

create index if not exists idx_whatsapp_events_user_received
  on public.whatsapp_events (user_id, received_at desc)
  where user_id is not null;
create index if not exists idx_whatsapp_events_wa_id_received
  on public.whatsapp_events (wa_id, received_at desc);

alter table public.whatsapp_events enable row level security;

revoke all on table public.whatsapp_events from public, anon, authenticated, service_role;
grant select, insert on table public.whatsapp_events to service_role;

commit;
