import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planTurn } from '../lib/chat-first/orchestrator';
import { freeAuditView, summarizeFreeAuditLedger } from '../lib/billing/free-audit';
import type { ChatRecommendation, ChatState } from '../lib/chat-first/contracts';

/**
 * Integration journey: PR57 (real Postgres ledger and RPCs) + PR62 hand-off +
 * PR59 chat planner. Needs an EMPTY scratch database in INTEGRATION_PG_URL
 * (never production). Synthetic users and accounts only.
 */
const url = process.env.INTEGRATION_PG_URL;
const skip = url ? false : 'set INTEGRATION_PG_URL to an empty scratch database to run the journey';

const NEW = '31111111-1111-1111-1111-111111111111';
const PAID = '32222222-2222-2222-2222-222222222222';
const ACC_NEW = '3aaaaaaa-0000-0000-0000-000000000001';
const ACC_PAID = '3bbbbbbb-0000-0000-0000-000000000001';
const CUST_NEW = '1112223334';
const CUST_PAID = '5556667778';

function psql(sql: string) {
  return execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], { encoding: 'utf8' }).trim();
}
function asUser(user: string, sql: string) {
  return psql(`set role authenticated; set request.jwt.claim.sub='${user}'; ${sql}`).split('\n').pop()!;
}
function asService(sql: string) {
  return psql(`set role service_role; ${sql}`).split('\n').pop()!;
}
function consume(user: string, acc: string) {
  const out = asUser(user, `select allowed||','||coalesce(reason,'-')||','||coalesce(event_id::text,'') from public.consume_free_audit('${acc}')`);
  const [allowed, reason, eventId] = out.split(',');
  return { allowed: allowed === 'true', reason, eventId };
}
function view(cust: string) {
  const rows = psql(`select status||'|'||coalesce(lease_expires_at::text,'') from public.free_audit_ledger where customer_id='${cust}' and status in ('completed','reserved')`)
    .split('\n')
    .filter(Boolean)
    .map((r) => {
      const [status, lease] = r.split('|');
      return { status, lease_expires_at: lease ? new Date(lease).toISOString() : null };
    });
  return freeAuditView(summarizeFreeAuditLedger(rows));
}

const rec = (over: Partial<ChatRecommendation> = {}): ChatRecommendation => ({
  id: 'r1', title: 'أوقف كلمة تصرف ولا تبيع', description: 'صرفت 90 دولار بلا تحويل', severity: 'critical', status: 'pending', executable: true, ...over,
});
const audit = { id: 'a1', healthScore: 62, findingsCount: 7, estimatedMonthlyWaste: 340, ranAt: '2026-10-08T10:00:00Z' };
const st = (over: Partial<ChatState>): ChatState => ({
  accountLinked: true, accountName: 'حساب تجريبي', customerId: CUST_NEW, latestAudit: null, recommendations: [], subscriptionActive: false, ...over,
});
const types = (t: ReturnType<typeof planTurn>) => t.actions.map((a) => a.action.type);

test('setup (scratch database, migration applied twice)', { skip }, () => {
  psql(`
    drop table if exists public.free_audit_ledger cascade;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    alter role service_role bypassrls;
    create table if not exists public.businesses (id uuid primary key, user_id uuid not null);
    create table if not exists public.google_ads_accounts (id uuid primary key, business_id uuid not null, customer_id text not null, status text not null default 'active', is_manager boolean);
    grant usage on schema public, auth to authenticated, service_role, anon;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    truncate public.google_ads_accounts, public.businesses;
    insert into public.businesses values ('${NEW}'::uuid,'${NEW}'::uuid),('${PAID}'::uuid,'${PAID}'::uuid);
    insert into public.google_ads_accounts (id, business_id, customer_id) values ('${ACC_NEW}','${NEW}','${CUST_NEW}'),('${ACC_PAID}','${PAID}','${CUST_PAID}');
  `);
  const sql = readFileSync(new URL('../db/migrations/20261009_free_audit_quota.sql', import.meta.url), 'utf8');
  for (let i = 0; i < 2; i++) execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql });
  psql('truncate public.free_audit_ledger');
});

test('1 start: no account, the chat guides to connect and promises nothing', { skip }, () => {
  const t = planTurn('انا جديد وابغى ابدا', st({ accountLinked: false, customerId: null, accountName: null }));
  assert.deepEqual(types(t), ['connect_account']);
  assert.match(t.reply, /ما عندي حساب/);
});

test('2 audit 1 reserved and completed on the real ledger, chat offers the re-run', { skip }, () => {
  assert.equal(view(CUST_NEW), 'available');
  const first = consume(NEW, ACC_NEW);
  assert.equal(first.allowed, true);
  assert.equal(view(CUST_NEW), 'in_progress', 'a live reservation is not exhausted');
  const mid = planTurn('افحص حسابي', st({ freeAudit: 'in_progress' }));
  assert.ok(!types(mid).includes('run_audit'), 'no second audit while one is running');
  assert.equal(asService(`select public.complete_free_audit('${first.eventId}','${NEW}','${ACC_NEW}')`), 'completed');
  assert.equal(view(CUST_NEW), 'available');
  const t = planTurn('وش وضع حسابي', st({ latestAudit: audit, recommendations: [rec()], freeAudit: view(CUST_NEW) }));
  assert.match(t.reply, /62/);
});

test('3 retry (audit 2) allowed once, then exhausted: no dead-end button, subscribe offered', { skip }, () => {
  const second = consume(NEW, ACC_NEW);
  assert.equal(second.allowed, true);
  assert.equal(asService(`select public.complete_free_audit('${second.eventId}','${NEW}','${ACC_NEW}')`), 'completed');
  const third = consume(NEW, ACC_NEW);
  assert.equal(third.allowed, false);
  assert.equal(view(CUST_NEW), 'exhausted');
  const t = planTurn('افحص حسابي من جديد', st({ latestAudit: audit, recommendations: [rec()], freeAudit: view(CUST_NEW) }));
  assert.ok(!types(t).includes('run_audit'));
  assert.ok(types(t).includes('subscribe'));
  assert.equal(t.cards[0]?.kind, 'audit_result', 'reading the last result stays free');
  const read = planTurn('وش وضع حسابي', st({ latestAudit: audit, recommendations: [rec()], freeAudit: 'exhausted' }));
  assert.match(read.reply, /62/);
});

test('4 apply: free user is gated to subscribe, subscriber gets preview then a confirm button', { skip }, () => {
  const free = planTurn('طبق التوصية', st({ latestAudit: audit, recommendations: [rec()], freeAudit: 'exhausted' }));
  assert.equal(free.cards.some((c) => c.kind === 'subscription_required'), true);
  assert.ok(!types(free).includes('approve') && !types(free).includes('execute'));
  const paid = planTurn('طبق التوصية', st({ latestAudit: audit, recommendations: [rec()], subscriptionActive: true }));
  assert.equal(paid.cards.some((c) => c.kind === 'approval'), true);
  assert.deepEqual(types(paid), ['approve']);
  for (const text of ['أوافق', 'نفذ', 'نفذ كل شي']) {
    assert.ok(!types(planTurn(text, st({ latestAudit: audit, recommendations: [rec()], subscriptionActive: true }))).includes('execute'), text);
  }
});

test('5 existing paid user is untouched by the free ledger', { skip }, () => {
  assert.equal(view(CUST_PAID), 'available');
  for (let i = 0; i < 3; i++) {
    const t = planTurn('افحص حسابي من جديد', st({ customerId: CUST_PAID, latestAudit: audit, subscriptionActive: true, freeAudit: undefined }));
    assert.ok(types(t).includes('run_audit'), 'paid user always keeps the audit button');
  }
  assert.equal(psql(`select count(*) from public.free_audit_ledger where customer_id='${CUST_PAID}'`), '0');
});

test('6 A and B: the exhausted state of A never leaks to B', { skip }, () => {
  assert.equal(view(CUST_NEW), 'exhausted');
  assert.equal(view(CUST_PAID), 'available');
  assert.equal(consume(PAID, ACC_PAID).allowed, true, 'B still has its own free audit');
  assert.throws(() => consume(PAID, ACC_NEW), /forbidden/, 'B cannot spend or read A: the RPC refuses');
});
