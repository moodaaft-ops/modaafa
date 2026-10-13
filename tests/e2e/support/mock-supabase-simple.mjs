// Fake Supabase (auth + REST) for tests/e2e/simple-experience.spec.ts. Synthetic data only, never a real account.
// Run: SCENARIO=questions node tests/e2e/support/mock-supabase-simple.mjs   (listens on 127.0.0.1:54321)
// Scenarios:
//   connect    signed up, nothing linked yet
//   questions  one account linked and synced, an audit on record, no setup answers yet
//   home       set up and subscribed, with open decisions, a week of numbers and two past chats
//   quiet      set up, but nothing spent in 7 days, no audit and no decisions
//   unpaid     like questions (audit on record, decisions pending) but with NO subscription: the paywall
//   unpaid_home  set up, audit and decisions on record, NO subscription: /home shows «خطتك جاهزة»
//   active     like home, but an active (paid) subscription instead of a trial
//   suspended  like home, but an operator suspended the account
// questions and home represent a customer WITH access (a live trial), so the older specs keep their flow.
// POST /__scenario?name=… switches scenario and clears stored answers, so one server serves the whole spec.
import http from 'node:http';

const UID = '11111111-1111-4111-8111-111111111111';
const BID = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const AUD = '55555555-5555-4555-8555-555555555555';
const now = new Date().toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

const user = {
  id: UID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'qa-tester@example.com',
  app_metadata: {},
  user_metadata: { full_name: 'Ayman Amin', given_name: 'أيمن' },
  created_at: hoursAgo(2),
};

const account = {
  id: A1, business_id: BID, customer_id: '1234567890', customer_name: 'متجر الريم للعطور', manager_id: null,
  status: 'active', is_manager: false, google_status: 'ENABLED', currency_code: 'SAR', time_zone: 'Asia/Riyadh',
  last_synced_at: hoursAgo(3), linked_at: hoursAgo(5), write_access: 'unknown',
};

const audit = {
  id: AUD, account_id: A1, health_score: 58,
  findings: [{ title: 'x' }, { title: 'y' }, { title: 'z' }, { title: 'w' }],
  estimated_monthly_waste: 1840, ran_at: hoursAgo(1),
};

const camp = (i, cost, conv) => ({
  id: `88888888-8888-4888-8888-88888888880${i}`, account_id: A1, google_campaign_id: 1000 + i,
  name: ['بحث العطور', 'الأداء الأقصى', 'العلامة'][i], type: ['SEARCH', 'PMAX', 'SEARCH'][i], status: 'ENABLED',
  daily_budget: 150, bidding_strategy: 'MAXIMIZE_CONVERSIONS',
  metrics_7d: { cost, clicks: 300, impressions: 9000, conversions: conv }, last_synced_at: hoursAgo(3),
});

const recs = [
  {
    id: '66666666-6666-4666-8666-666666666600', audit_id: AUD, account_id: A1, severity: 'critical', status: 'pending',
    title: 'أوقف عبارة «عطور رخيصة»: صرفت 412 ريال بدون ولا طلب',
    description: 'العبارة جابت 96 ضغطة في 30 يوم وما سجلت أي شراء، والناس اللي يكتبونها يدورون أسعار أقل من منتجاتك.',
    expected_impact: { metric: 'cost', delta_sar_per_month: 412 },
    action_payload: { operation: 'add_negative_keyword', target_id: 'customers/1234567890/campaigns/1000', params: { campaign_resource: 'customers/1234567890/campaigns/1000', keyword_text: 'عطور رخيصة', match_type: 'PHRASE' } },
    created_at: hoursAgo(1),
  },
  {
    id: '66666666-6666-4666-8666-666666666601', audit_id: AUD, account_id: A1, severity: 'medium', status: 'pending',
    title: 'حملة «الأداء الأقصى» توقف قبل الظهر كل يوم لأن ميزانيتها تخلص',
    description: 'آخر 7 أيام خلصت الميزانية قبل الساعة 12 في 6 أيام، وأكثر طلباتك تجي بعد العصر.',
    expected_impact: { metric: 'conversions', delta_sar_per_month: 0 },
    action_payload: { operation: 'review_budget_pacing' },
    created_at: hoursAgo(2),
  },
  {
    id: '66666666-6666-4666-8666-666666666602', audit_id: AUD, account_id: A1, severity: 'growth', status: 'pending',
    title: 'أضف عبارة «عطر عود فاخر» لحملة البحث',
    description: 'تطلع في بحث الناس عنك وجابت 4 طلبات من حملة ثانية بتكلفة أقل.',
    expected_impact: { metric: 'conversions', delta_sar_per_month: 0 },
    action_payload: { operation: 'review_keyword' },
    created_at: hoursAgo(3),
  },
  {
    id: '66666666-6666-4666-8666-666666666603', audit_id: AUD, account_id: A1, severity: 'growth', status: 'pending',
    title: 'إعلانك ما فيه سعر، والمنافسين كلهم كاتبين أسعارهم',
    description: 'إضافة السعر في الإعلان تقلل الضغطات من ناس مو مستعدين يشترون.',
    expected_impact: null, action_payload: { operation: 'review_ads' }, created_at: hoursAgo(4),
  },
];

// A live Stripe trial: the customer has access. Used by every scenario that is not about the paywall.
const trialingSubscription = () => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: UID, plan: 'growth', billing_period: 'monthly', status: 'trialing',
  trial_ends_at: new Date(Date.now() + 10 * 864e5).toISOString(), current_period_start: hoursAgo(96),
  current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(), created_at: hoursAgo(96), canceled_at: null,
});

const SCENARIOS = {
  connect: () => ({
    businesses: [{ id: BID, user_id: UID, name: 'Ayman Amin', sector: null, website: null, monthly_budget: null, primary_goal: 'leads', target_regions: [], selected_google_ads_customer_id: null }],
    google_ads_accounts: [], job_runs: [], audits: [], recommendations: [], campaigns_cache: [], subscriptions: [], ai_actions: [],
  }),
  questions: () => ({
    businesses: [{ id: BID, user_id: UID, name: 'Ayman Amin', sector: null, website: null, monthly_budget: null, primary_goal: 'leads', target_regions: [], selected_google_ads_customer_id: null }],
    google_ads_accounts: [account],
    job_runs: [{ id: 'job1', job_name: `google_ads_connect:${UID}`, status: 'success', started_at: hoursAgo(1), finished_at: hoursAgo(1), details: { stage: 'done', spend: { '1234567890': 4320 } } }],
    audits: [audit], recommendations: recs, campaigns_cache: [camp(0, 620, 9), camp(1, 480, 7), camp(2, 140, 2)], subscriptions: [trialingSubscription()], ai_actions: [],
  }),
  // The same journey for someone with no subscription at all: the questions end on «خطتك جاهزة».
  unpaid: () => ({ ...SCENARIOS.questions(), subscriptions: [] }),
  home: () => ({
    businesses: [{ id: BID, user_id: UID, name: 'متجر الريم للعطور', sector: 'متجر إلكتروني', website: 'https://alreem.example', monthly_budget: 4300, primary_goal: 'conversions', target_regions: ['الرياض', 'جدة'], selected_google_ads_customer_id: '1234567890' }],
    google_ads_accounts: [account],
    job_runs: [], audits: [audit], recommendations: recs, campaigns_cache: [camp(0, 620, 9), camp(1, 480, 7), camp(2, 140, 2)],
    subscriptions: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: UID, plan: 'growth', billing_period: 'monthly', status: 'trialing', trial_ends_at: new Date(Date.now() + 10 * 864e5).toISOString(), current_period_start: hoursAgo(96), current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(), created_at: hoursAgo(96), canceled_at: null }],
    ai_actions: [{ id: '77777777-7777-4777-8777-777777777777', account_id: A1, action_type: 'add_negative_keyword', description_ar: 'منعت إعلانك يطلع لعبارة «عطور مجانية»', created_at: hoursAgo(30), reverted_at: null }],
    chat_sessions: [
      { id: '99999999-9999-4999-8999-999999999901', user_id: UID, account_id: A1, title: 'وين تروح فلوسي في الإعلانات؟', created_at: hoursAgo(20), updated_at: hoursAgo(20) },
      { id: '99999999-9999-4999-8999-999999999902', user_id: UID, account_id: A1, title: 'ليش الطلبات قليلة في الويكند؟', created_at: hoursAgo(50), updated_at: hoursAgo(50) },
    ],
    chat_messages: [
      { id: '98989898-9898-4898-8898-989898989801', session_id: '99999999-9999-4999-8999-999999999901', role: 'user', content: 'وين تروح فلوسي في الإعلانات؟', tool_results: null, seq: 1, created_at: hoursAgo(20) },
      { id: '98989898-9898-4898-8898-989898989802', session_id: '99999999-9999-4999-8999-999999999901', role: 'assistant', content: 'أكبر هدر عندك آخر 30 يوم عبارة «عطور رخيصة»: صرفت عليها 412 ريال وما جابت ولا طلب. لو اعتمدت إيقافها من الرئيسية توفّر تقريباً نفس المبلغ كل شهر.', tool_results: null, seq: 2, created_at: hoursAgo(20) },
    ],
  }),
  // Same store, plus more ad accounts under the same login, for the account menu.
  multi: () => ({
    ...SCENARIOS.home(),
    google_ads_accounts: [
      account,
      { ...account, id: '33333333-3333-4333-8333-333333333334', customer_id: '4779964593', customer_name: 'مركز الشفاء الطبي' },
      { ...account, id: '33333333-3333-4333-8333-333333333335', customer_id: '8418400543', customer_name: 'حياة أجمل للتجميل' },
      { ...account, id: '33333333-3333-4333-8333-333333333336', customer_id: '5550001122', customer_name: 'مطعم البيت الشامي' },
    ],
  }),
  quiet: () => ({
    ...SCENARIOS.home(),
    audits: [], recommendations: [], ai_actions: [], chat_sessions: [], chat_messages: [],
    campaigns_cache: [camp(0, 0, 0), camp(1, 0, 0)],
  }),
  unpaid_home: () => ({ ...SCENARIOS.home(), subscriptions: [], chat_sessions: [], chat_messages: [] }),
  active: () => ({
    ...SCENARIOS.home(),
    subscriptions: [{ ...trialingSubscription(), status: 'active', trial_ends_at: null, current_period_end: new Date(Date.now() + 25 * 864e5).toISOString() }],
  }),
  suspended: () => ({
    ...SCENARIOS.home(),
    account_access_overrides: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: UID, kind: 'suspension', plan: null, expires_at: null, created_at: hoursAgo(1), revoked_at: null }],
  }),
};

let scenario = process.env.SCENARIO || 'questions';
let tables = {};
function reset(name) {
  scenario = SCENARIOS[name] ? name : 'questions';
  tables = {
    users: [{ id: UID, email: user.email, name: 'Ayman Amin', preferred_lang: 'ar', registered_at: hoursAgo(5) }],
    autopilot_settings: [], business_memory: [], chat_sessions: [], chat_messages: [], usage_events: [],
    billing_trial_grants: [], billing_trial_ledger: [], free_audit_ledger: [], sector_benchmarks: [], account_access_overrides: [],
    ...SCENARIOS[scenario](),
  };
}
reset(scenario);

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, h = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...h });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, {}, { 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
  if (u.pathname === '/__scenario') { reset(u.searchParams.get('name')); return send(200, { scenario }); }
  if (u.pathname === '/auth/v1/user') return send(200, user);
  if (u.pathname.startsWith('/auth/v1/')) return send(200, {});
  if (u.pathname === '/rest/v1/rpc/consume_rate_limit') {
    return send(200, [{ allowed: true, remaining: 50, reset_at: new Date(Date.now() + 60e3).toISOString() }]);
  }
  if (u.pathname.startsWith('/rest/v1/rpc/')) return send(200, null);
  const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
  if (m) {
    const name = m[1];
    const rows = tables[name] ?? [];
    const accept = req.headers.accept || '';
    if (req.method === 'POST') {
      const body = await readBody(req);
      const items = (Array.isArray(body) ? body : body ? [body] : []).map((item) => ({ id: crypto.randomUUID(), ...item }));
      if (name === 'business_memory') {
        for (const item of items) rows.push({ id: `m${rows.length}`, status: 'active', created_at: new Date().toISOString(), ...item });
        tables[name] = rows;
      }
      if (name === 'autopilot_settings') tables[name] = items;
      if (name === 'chat_sessions' || name === 'chat_messages') tables[name] = [...items, ...rows];
      return send(201, accept.includes('vnd.pgrst.object') ? items[0] ?? {} : items);
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (name === 'businesses' && body && tables.businesses[0]) Object.assign(tables.businesses[0], body);
      return send(200, []);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(204, []);
    let out = rows;
    // The one filter the specs depend on: onboarding answers only.
    if (name === 'business_memory' && u.searchParams.get('source') === 'eq.onboarding') {
      out = rows.filter((r) => r.source === 'onboarding' && r.status === 'active').reverse();
    }
    const lim = Number(u.searchParams.get('limit') || out.length);
    out = out.slice(0, lim);
    if (accept.includes('vnd.pgrst.object')) {
      return out.length ? send(200, out[0]) : send(406, { code: 'PGRST116', message: 'none', details: '', hint: '' });
    }
    return send(200, out, { 'content-range': `0-${Math.max(out.length - 1, 0)}/${rows.length}` });
  }
  send(404, { message: 'mock: ' + u.pathname });
}).listen(54321, '127.0.0.1', () => console.log(`mock supabase (simple, ${scenario}) on 54321`));
