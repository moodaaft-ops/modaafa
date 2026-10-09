#!/usr/bin/env bash
# Starts the local stack: Postgres + Auth (GoTrue) + REST (PostgREST) + gateway + LLM stub.
# Everything binds to 127.0.0.1. No production secret or data is read or written.
# Requires: docker, node 22, psql (client only), openssl.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$ROOT/.local-stack"
# shellcheck disable=SC1091
. "$HERE/versions.env"
mkdir -p "$STATE"
umask 077

for tool in docker node psql openssl; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 1; }

if [ -e "$STATE/env" ]; then
  echo "A stack is already prepared at .local-stack. Run scripts/local-stack/down.sh first." >&2
  exit 1
fi

rand() { openssl rand -hex "$1"; }
JWT_SECRET="$(rand 32)"
DB_PASSWORD="$(rand 12)"
LOCAL_DB="postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${PG_PORT}"

jwt() { # role
  node -e "
const c=require('crypto');const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const h=b({alg:'HS256',typ:'JWT'}),p=b({role:process.argv[2],iss:'local-stack',iat:1790000000,exp:2000000000});
process.stdout.write(h+'.'+p+'.'+c.createHmac('sha256',process.argv[1]).update(h+'.'+p).digest('base64url'));" "$JWT_SECRET" "$1"
}

echo "1/6 postgres"
docker run -d --name ls-postgres -p "127.0.0.1:${PG_PORT}:5432" -e POSTGRES_PASSWORD="$DB_PASSWORD" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 40); do
  docker exec ls-postgres pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
PSQL=(psql -q -v ON_ERROR_STOP=1 "$LOCAL_DB/postgres")
"${PSQL[@]}" -c "create database app" -c "create database fa_scratch"
LOCAL_APP_DB="$LOCAL_DB/app"
psql -q -v ON_ERROR_STOP=1 "$LOCAL_APP_DB" <<'SQL'
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'localonly';
create role dashboard_user nologin;
-- GoTrue's own migrations need these in a throwaway local database.
create role supabase_auth_admin login superuser password 'localonly';
grant anon, authenticated, service_role to authenticator;
create schema auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;
alter role supabase_auth_admin set search_path = auth, public;
SQL

echo "2/6 auth"
docker run -d --name ls-auth --network host \
  -e GOTRUE_API_HOST=127.0.0.1 -e PORT="$AUTH_PORT" -e API_EXTERNAL_URL="http://127.0.0.1:${AUTH_PORT}" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:localonly@127.0.0.1:${PG_PORT}/app?search_path=auth" \
  -e GOTRUE_SITE_URL="http://127.0.0.1:${APP_PORT}" -e GOTRUE_URI_ALLOW_LIST="http://127.0.0.1:${APP_PORT}/**" \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_DISABLE_SIGNUP=false \
  -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  "$AUTH_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${AUTH_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${AUTH_PORT}/health" >/dev/null || { docker logs ls-auth 2>&1 | tail -3 >&2; echo "auth did not start" >&2; exit 1; }

echo "3/6 schema (db/schema.sql + migrations, pg_cron scheduler skipped)"
psql -q -v ON_ERROR_STOP=1 "$LOCAL_APP_DB" -f "$ROOT/db/schema.sql" >/dev/null
# The scheduler migration needs pg_cron/pg_net/vault and calls ai.modaafa.com, so it is never applied here.
psql -q -v ON_ERROR_STOP=1 "$LOCAL_APP_DB" -c "create table if not exists public._modaafa_migrations (name text primary key, applied_at timestamptz not null default now()); insert into public._modaafa_migrations(name) values ('20261005_pg_cron_scheduler.sql') on conflict do nothing;"
( cd "$ROOT" && SUPABASE_DB_URL="$LOCAL_APP_DB" node scripts/migrate.mjs | tail -2 )
psql -q -v ON_ERROR_STOP=1 "$LOCAL_APP_DB" <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on functions to service_role;
SQL
LEAKS="$(psql -At "$LOCAL_APP_DB" -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and p.prosrc ilike '%ai.modaafa.com%'")"
[ "$LEAKS" = "0" ] || { echo "a function mentions production, stopping" >&2; exit 1; }

echo "4/6 rest"
docker run -d --name ls-rest --network host \
  -e PGRST_DB_URI="postgres://authenticator:localonly@127.0.0.1:${PG_PORT}/app" -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_SERVER_PORT="$REST_PORT" "$REST_IMAGE" >/dev/null

echo "5/6 gateway + llm stub"
export AUTH_PORT REST_PORT GATEWAY_PORT LLM_STUB_PORT
setsid nohup node "$HERE/gateway.mjs" >"$STATE/gateway.log" 2>&1 & echo $! >"$STATE/gateway.pid"
setsid nohup node "$HERE/llm-stub.mjs" >"$STATE/llm-stub.log" 2>&1 & echo $! >"$STATE/llm-stub.pid"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/rest/v1/" -H "apikey: x" >/dev/null 2>&1 && break
  sleep 1
done

echo "6/6 env file (.local-stack/env, git-ignored, random keys)"
{
  echo "NEXT_PUBLIC_APP_URL=http://127.0.0.1:${APP_PORT}"
  echo "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${GATEWAY_PORT}"
  echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$(jwt anon)"
  echo "SUPABASE_SERVICE_ROLE_KEY=$(jwt service_role)"
  echo "ENCRYPTION_KEY=$(rand 32)"
  echo "CRON_SECRET=$(rand 24)"
  echo "HEALTH_SECRET=$(rand 24)"
  echo "ANTHROPIC_API_KEY=local-stub-key"
  echo "ANTHROPIC_BASE_URL=http://127.0.0.1:${LLM_STUB_PORT}"
  echo "CHAT_FIRST_ENTRY=true"
  echo "VOICE_ASSISTANT_ENABLED=false"
  # Explicitly off, so nothing is inherited from a shell that has real values.
  for name in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PUBLISHABLE_KEY RESEND_API_KEY TIKTOK_PIXEL_ID \
    GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_ADS_DEVELOPER_TOKEN ELEVENLABS_API_KEY; do
    echo "${name}=\"\""
  done
  echo "LOCAL_APP_DB=${LOCAL_APP_DB}"
  echo "LOCAL_SCRATCH_DB=${LOCAL_DB}/fa_scratch"
  echo "LLM_STUB_PORT=${LLM_STUB_PORT}"
  echo "APP_PORT=${APP_PORT}"
} >"$STATE/env"
chmod 600 "$STATE/env"
echo "Stack is up. Next: scripts/local-stack/verify.sh"
