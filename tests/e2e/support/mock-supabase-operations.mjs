// Fake Supabase for looking at the operations center (/operations) without a real database.
// Synthetic customers only. Unlike mock-supabase.mjs it honours the simple filters the
// operations pages use (eq, in, gte, is.null, limit/offset) and the auth admin endpoints.
//
// Run:   node tests/e2e/support/mock-supabase-operations.mjs   (127.0.0.1:54321)
// App:   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon \
//        SUPABASE_SERVICE_ROLE_KEY=service MODAAFA_OPERATOR_EMAILS=qa-operator@example.com pnpm start
// Login: cookie sb-127-auth-token = a session JSON for the operator below (see tests/e2e/mobile-layout.spec.ts).
// MOCK_OVERRIDES=0 serves the two operator tables as missing, like production before the migration.
import http from 'node:http';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (days) => new Date(NOW + days * DAY).toISOString();
const id = (n, prefix = 'c') => {
  const hex = n.toString(16).padStart(12, '0');
  const p = { c: '1c1c1c1c', b: '2b2b2b2b', a: '3a3a3a3a', s: '4d4d4d4d', r: '5e5e5e5e' }[prefix];
  return `${p}-0000-4000-8000-${hex}`;
};

const OPERATOR_ID = '99999999-9999-4999-8999-999999999999';
const operator = {
  id: OPERATOR_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'qa-operator@example.com',
  email_confirmed_at: iso(-90),
  last_sign_in_at: iso(0),
  app_metadata: {},
  user_metadata: {},
  created_at: iso(-90),
};

const shops = ['متجر عبايات الريم', 'ورد الياسمين', 'عسل الجبل', 'محمصة بن', 'نظارات الرؤية', 'كفرات الطريق', 'مطعم مندي', 'مغسلة سيارات', 'عيادة أسنان', 'ستائر الفخامة', 'متجر ألعاب', 'تظليل وعوازل', 'حلويات البيت', 'أثاث مكتبي', 'عطور شرقية'];
const sectors = ['متجر إلكتروني', 'خدمات منزلية', 'عيادة', 'مطعم'];

const users = [{ id: OPERATOR_ID, email: operator.email, name: 'أيمن', created_at: iso(-90), last_login_at: iso(0) }];
const authUsers = [operator];
const businesses = [{ id: id(999, 'b'), user_id: OPERATOR_ID, name: 'مُضاعفة', created_at: iso(-90) }];
const accounts = [];
const audits = [];
const subscriptions = [];
const invoices = [];
const usage = [];
const recommendations = [];
const overrides = [];

// 48 customers spread across every stage and state.
for (let n = 1; n <= 48; n += 1) {
  const uid = id(n);
  const created = -(n % 30) - (n > 40 ? 20 : 0) - 0.3;
  const email = `customer${n}@shop${n}.sa`;
  const stage = n % 8; // 0 signed up .. 7 paying
  users.push({ id: uid, email, name: n % 3 ? null : `عميل ${n}`, phone: n % 4 === 0 ? `05${String(50000000 + n * 1371).slice(0, 8)}` : null, created_at: iso(created), last_login_at: null });
  authUsers.push({ id: uid, email, email_confirmed_at: stage >= 1 ? iso(created + 0.01) : null, last_sign_in_at: stage >= 1 ? iso(Math.min(0, created + (n % 9))) : null });
  if (stage >= 2) businesses.push({ id: id(n, 'b'), user_id: uid, name: shops[n % shops.length], sector: sectors[n % 4], website: `https://shop${n}.sa`, created_at: iso(created + 0.02), monthly_budget: 3000 + n * 100 });
  if (stage >= 3) {
    const googleOff = n === 11 || n === 27;
    accounts.push({ id: id(n, 'a'), business_id: id(n, 'b'), customer_id: String(1000000000 + n * 7919), customer_name: shops[n % shops.length], status: googleOff ? 'paused' : 'active', google_status: googleOff ? 'CUSTOMER_NOT_ENABLED' : 'ENABLED', is_manager: false, linked_at: iso(created + 0.5), last_synced_at: iso(-0.05), last_optimized_at: iso(-0.1) });
  }
  if (stage >= 4) audits.push({ account_id: id(n, 'a'), ran_at: iso(created + 1), health_score: 60 + (n % 30) });
  if (stage >= 5) {
    const ends = stage === 7 ? null : (n % 14) - 2;
    const status = stage === 7 ? (n === 15 ? 'past_due' : 'active') : ends !== null && ends < 0 ? 'canceled' : 'trialing';
    subscriptions.push({ id: id(n, 's'), user_id: uid, plan: ['starter', 'growth', 'pro'][n % 3], billing_period: 'monthly', status, trial_ends_at: stage === 7 ? iso(-20) : iso(ends), current_period_start: iso(-10), current_period_end: iso(20), created_at: iso(created + 1.2), stripe_subscription_id: `sub_mock_${n}`, canceled_at: status === 'canceled' ? iso(-1) : null });
    if (stage === 7 && status === 'active') invoices.push({ user_id: uid, status: 'paid', amount_sar: [500, 1200, 2500][n % 3], currency: 'SAR', invoice_number: `MDF-${1000 + n}`, paid_at: iso(-10), created_at: iso(-10) });
  }
  if (stage >= 4 && n % 2) for (let k = 0; k < (n % 5) + 1; k += 1) usage.push({ user_id: uid, feature: ['assistant', 'audit', 'execute_action', 'manual_sync'][k % 4], created_at: iso(-(k % 9) - 0.2) });
  if (stage >= 4) {
    recommendations.push({ id: id(n * 10, 'r'), account_id: id(n, 'a'), title: 'إضافة كلمات سلبية لعبارات البحث غير المربحة', status: n === 21 ? 'failed' : n % 3 ? 'pending' : 'applied', severity: 'critical', category: 'keywords', created_at: iso(-2), applied_at: n % 3 ? null : iso(-1) });
    if (n === 29) recommendations.push({ id: id(n * 10 + 1, 'r'), account_id: id(n, 'a'), title: 'نقل 150 ريال لحملة البحث الرابحة', status: 'executing', severity: 'growth', category: 'budget', created_at: iso(-0.2), execution_started_at: iso(-0.1) });
  }
}
// Free plan for one, suspension for another.
if (process.env.MOCK_OVERRIDES !== '0') {
  overrides.push({ id: 'o1', user_id: id(13), kind: 'plan_grant', plan: 'pro', expires_at: iso(30), created_at: iso(-2), revoked_at: null });
  overrides.push({ id: 'o2', user_id: id(19), kind: 'suspension', plan: null, expires_at: null, created_at: iso(-1), revoked_at: null });
}

const jobs = [];
for (let h = 0; h < 30; h += 1) {
  jobs.push({ id: `j-sync-${h}`, job_name: 'sync-google-ads', status: h === 3 ? 'failed' : 'success', started_at: iso(-h / 6), processed: 24, error_count: h === 3 ? 24 : 0, error_message: h === 3 ? 'Google Ads API: QUOTA_ERROR RESOURCE_TEMPORARILY_EXHAUSTED' : null });
  jobs.push({ id: `j-opt-${h}`, job_name: 'optimize', status: 'success', started_at: iso(-h / 4), processed: 22, error_count: h % 7 === 0 ? 1 : 0 });
}
// Cost-guard counters on the recent optimizer runs, the way the cron now records them.
for (const job of jobs) {
  if (job.job_name !== 'optimize') continue;
  const h = Number(job.id.replace('j-opt-', ''));
  if (h < 8) job.details = { model_calls: 16 - (h % 3), skipped_idle: 3 + (h % 2), cooled_down_accounts: h % 2 ? 14 : 9, cooldown_hours: 12, batch_limit: 60 };
}

// Synthetic LLM ledger for /operations/costs: 14 days, deterministic. MOCK_LLM=0 serves the
// table as missing (like production before the migration), MOCK_LLM=empty serves it with no rows.
const llmUsage = [];
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
for (let day = 0; day < 14; day += 1) {
  const runs = day % 5 === 0 ? 4 : 2;
  for (let run = 0; run < runs; run += 1) {
    for (let call = 0; call < 14 + Math.floor(rand() * 6); call += 1) {
      const cached = day < 2 && call > 0;
      llmUsage.push({
        id: `l-${day}-${run}-${call}`,
        created_at: iso(-day - (run * 0.21 + call * 0.002)),
        user_id: id(8 + ((call + run) % 18)),
        feature: 'optimizer',
        model: 'claude-sonnet-5-5',
        input_tokens: cached ? 5200 : 7400,
        output_tokens: 380 + Math.floor(rand() * 300),
        cache_read_tokens: cached ? 1900 : 0,
        cache_write_tokens: !cached && day < 2 && call === 0 ? 1900 : 0,
        cost_usd: cached ? 0.0148 + rand() * 0.004 : 0.0203 + rand() * 0.006,
        priced: true,
      });
    }
  }
  for (let k = 0; k < 1 + (day % 3); k += 1) {
    llmUsage.push({ id: `a-${day}-${k}`, created_at: iso(-day - 0.4 - k * 0.1), user_id: id(10 + k), feature: 'audit', model: 'claude-opus-5-5', input_tokens: 21000, output_tokens: 1700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.118 + rand() * 0.04, priced: true });
  }
  for (let k = 0; k < 3 + Math.floor(rand() * 5); k += 1) {
    llmUsage.push({ id: `s-${day}-${k}`, created_at: iso(-day - 0.15 - k * 0.03), user_id: id(9 + (k % 4)), feature: k % 3 ? 'assistant' : 'jarvis', model: 'claude-sonnet-5-5', input_tokens: 6200, output_tokens: 720, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.019 + rand() * 0.012, priced: true });
  }
  if (day % 4 === 1) llmUsage.push({ id: `b-${day}`, created_at: iso(-day - 0.3), user_id: id(12), feature: 'campaign_builder', model: 'claude-sonnet-5-5', input_tokens: 14000, output_tokens: 3100, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.071, priced: true });
}

jobs.push({ id: 'j-connect', job_name: `google_ads_connect:${id(40)}`, status: 'success', started_at: iso(-1), processed: 1, error_count: 0 });

const tables = {
  users,
  businesses,
  google_ads_accounts: accounts,
  audits,
  subscriptions,
  invoices,
  usage_events: usage,
  recommendations,
  ai_actions: [{ id: 'x1', account_id: id(7, 'a'), action_type: 'add_negative_keyword', description_ar: 'أضاف 12 كلمة سلبية لحملة البحث', created_at: iso(-3), rollback_status: null }],
  job_runs: jobs,
  llm_usage: process.env.MOCK_LLM === '0' ? null : process.env.MOCK_LLM === 'empty' ? [] : llmUsage,
  processed_webhook_events: [{ event_id: 'evt_1', event_type: 'invoice.payment_failed', status: 'failed', attempts: 3, last_attempt_at: iso(-0.5), error_message: 'timeout' }],
  account_access_overrides: overrides,
  operator_audit_log: process.env.MOCK_OVERRIDES === '0' ? null : [
    { id: 'l1', operator_email: operator.email, action: 'grant_plan', target_user_id: id(13), status: 'succeeded', reason: 'تعويض عن عطل المحسّن في أكتوبر', details: {}, created_at: iso(-2) },
    { id: 'l2', operator_email: operator.email, action: 'suspend', target_user_id: id(19), status: 'succeeded', reason: 'طلب استرجاع ونزاع على البطاقة', details: {}, created_at: iso(-1) },
  ],
  chat_sessions: [],
  autopilot_settings: [],
  campaigns_cache: [],
  reports: [],
};

function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue;
    const value = String(raw);
    if (value.startsWith('eq.')) out = out.filter((row) => String(row[key]) === value.slice(3));
    else if (value.startsWith('in.(')) {
      const set = new Set(value.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, '')));
      out = out.filter((row) => set.has(String(row[key])));
    } else if (value.startsWith('gte.')) out = out.filter((row) => row[key] && row[key] >= value.slice(4));
    else if (value === 'is.null') out = out.filter((row) => row[key] == null);
    else if (value === 'not.is.null') out = out.filter((row) => row[key] != null);
  }
  return out;
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, h = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...h });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, {}, { 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    if (u.pathname === '/auth/v1/user') return send(200, operator);
    if (u.pathname === '/auth/v1/admin/users') return send(200, { users: authUsers, aud: 'authenticated' }, { 'x-total-count': String(authUsers.length) });
    const adminUser = u.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (adminUser) {
      const found = authUsers.find((row) => row.id === adminUser[1]);
      return found ? send(200, found) : send(404, { msg: 'User not found' });
    }
    if (u.pathname.startsWith('/auth/v1/')) return send(200, {});
    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (m) {
      const table = tables[m[1]];
      if (table === null || (table === overrides && process.env.MOCK_OVERRIDES === '0')) {
        return send(404, { code: '42P01', message: `relation "public.${m[1]}" does not exist`, details: null, hint: null });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(201, []);
      const rows = applyFilters(table ?? [], u.searchParams);
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || rows.length);
      const out = rows.slice(offset, offset + limit);
      if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
        return out.length ? send(200, out[0]) : send(406, { code: 'PGRST116', message: 'none', details: '', hint: '' });
      }
      return send(200, out, { 'content-range': `${offset}-${Math.max(offset + out.length - 1, offset)}/${rows.length}` });
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) return send(200, null);
    send(404, { message: 'mock: ' + u.pathname });
  })
  .listen(54321, '127.0.0.1', () => console.log(`mock supabase (operations) on 54321, ${users.length - 1} customers`));
