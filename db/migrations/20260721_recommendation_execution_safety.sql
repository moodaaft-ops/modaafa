alter table public.recommendations
  drop constraint if exists recommendations_status_check;

alter table public.recommendations
  add constraint recommendations_status_check
  check (status in ('pending', 'approved', 'executing', 'applied', 'dismissed', 'failed'));

alter table public.recommendations
  add column if not exists fingerprint text,
  add column if not exists execution_key uuid,
  add column if not exists execution_started_at timestamptz;

create unique index if not exists recommendations_active_fingerprint_idx
  on public.recommendations (account_id, fingerprint)
  where fingerprint is not null and status in ('pending', 'approved', 'executing');

create unique index if not exists recommendations_execution_key_idx
  on public.recommendations (execution_key)
  where execution_key is not null;

alter table public.ai_actions
  add column if not exists recommendation_id uuid references public.recommendations (id) on delete set null,
  add column if not exists execution_key uuid,
  add column if not exists rollback_payload jsonb,
  add column if not exists rollback_status text,
  add column if not exists rollback_key uuid,
  add column if not exists rollback_started_at timestamptz,
  add column if not exists rollback_result jsonb;

alter table public.ai_actions
  drop constraint if exists ai_actions_rollback_status_check;

alter table public.ai_actions
  add constraint ai_actions_rollback_status_check
  check (rollback_status is null or rollback_status in ('executing', 'reverted', 'failed'));

create unique index if not exists ai_actions_execution_key_idx
  on public.ai_actions (execution_key)
  where execution_key is not null;

create unique index if not exists ai_actions_rollback_key_idx
  on public.ai_actions (rollback_key)
  where rollback_key is not null;

create index if not exists ai_actions_recommendation_idx
  on public.ai_actions (recommendation_id, created_at desc);
