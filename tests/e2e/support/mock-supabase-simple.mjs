// Fake Supabase (auth + REST) for tests/e2e/simple-experience.spec.ts. Synthetic data only, never a real account.
// Run: SCENARIO=questions node tests/e2e/support/mock-supabase-simple.mjs   (listens on 127.0.0.1:54321)
// Scenarios:
//   connect    signed up, nothing linked yet
//   questions  one account linked and synced, an audit on record, no setup answers yet
//   home       set up and subscribed, with open decisions, a week of numbers and two past chats
//   quiet      set up, but nothing spent in 7 days, no audit and no decisions
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

const SCENARIOS = {
  connect: () => ({
    businesses: [{ id: BID, user_id: UID, name: 'Ayman Amin', sector: null, website: null, monthly_budget: null, primary_goal: 'leads', target_regions: [], selected_google_ads_customer_id: null }],
    google_ads_accounts: [], job_runs: [], audits: [], recommendations: [], campaigns_cache: [], subscriptions: [], ai_actions: [],
  }),
  questions: () => ({
    businesses: [{ id: BID, user_id: UID, name: 'Ayman Amin', sector: null, website: null, monthly_budget: null, primary_goal: 'leads', target_regions: [], selected_google_ads_customer_id: null }],
    google_ads_accounts: [account],
    job_runs: [{ id: 'job1', job_name: `google_ads_connect:${UID}`, status: 'success', started_at: hoursAgo(1), finished_at: hoursAgo(1), details: { stage: 'done', spend: { '1234567890': 4320 } } }],
    audits: [audit], recommendations: recs, campaigns_cache: [camp(0, 620, 9), camp(1, 480, 7), camp(2, 140, 2)], subscriptions: [], ai_actions: [],
  }),
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

// ===== BEGIN restyle-pages block =====
// Synthetic data for /campaigns, /reports, /billing and /settings. Additive only: it adds scenarios, it changes none.
//   pages      set up, live Stripe subscription, six campaigns, reports, three invoices
//   pages-new  set up, nothing paid yet (plan picker), no campaigns, reports or invoices
const pageCamp = (i, name, type, status, budget, cost30, conv30) => ({
  id: `88888888-8888-4888-8888-8888888809${String(i).padStart(2, '0')}`, account_id: A1, google_campaign_id: 2000 + i,
  name, type, status, daily_budget: budget, bidding_strategy: 'MAXIMIZE_CONVERSIONS',
  metrics_7d: { cost: Math.round(cost30 / 4), clicks: 120, impressions: 4000, conversions: Math.round(conv30 / 4) },
  metrics_30d: { cost: cost30, clicks: 520, impressions: 17000, conversions: conv30 },
  last_synced_at: hoursAgo(3),
});
const pageCampaigns = [
  pageCamp(0, 'بحث العطور', 'SEARCH', 'ENABLED', 150, 2480, 36),
  pageCamp(1, 'الأداء الأقصى للمتجر', 'PERFORMANCE_MAX', 'ENABLED', 200, 1920, 28),
  pageCamp(2, 'حماية اسم العلامة', 'SEARCH', 'ENABLED', 40, 560, 11),
  pageCamp(3, 'تسوق منتجات العود', 'SHOPPING', 'ENABLED', 90, 410, 4),
  pageCamp(4, 'إعادة الاستهداف للزوار', 'DISPLAY', 'PAUSED', 60, 130, 1),
  pageCamp(5, 'حملة رمضان الماضي', 'SEARCH', 'PAUSED', 120, 0, 0),
];
const pageReports = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001', account_id: A1, period_type: 'weekly', generated_at: hoursAgo(20),
    summary_ar: 'صرفت هالأسبوع أكثر من اللي قبله بشوي، بس الطلبات زادت أكثر من الصرف. أغلب الزيادة جات من حملة «بحث العطور» بعد ما أوقفت عبارة «عطور رخيصة».',
    metrics: {
      kind: 'weekly_performance', currency_code: 'SAR',
      totals: { this_week: { cost: 1240, conversions: 18 }, prior_week: { cost: 1105, conversions: 13 }, delta: { cost: 135, conversions: 5, cpa_this: 68.9, cpa_prior: 85 } },
      highlights_ar: ['حملة «بحث العطور» جابت 9 طلبات بتكلفة أقل من الأسبوع اللي قبله', 'حملة «الأداء الأقصى للمتجر» ميزانيتها تخلص قبل العصر'],
      next_week_ar: 'وزّع ميزانية «الأداء الأقصى للمتجر» على ساعات اليوم كلها عشان تلحق طلبات المساء',
    },
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000002', account_id: A1, period_type: 'custom', generated_at: hoursAgo(26),
    summary_ar: 'فحصت حسابك ولقيت 4 نقاط تحتاج قرار، أهمها عبارة صرفت عليها بدون ولا طلب.',
    metrics: { kind: 'audit_summary', health_score: 58, recommendations_count: 4, estimated_monthly_waste_sar: 1840, currency_code: 'SAR' },
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000003', account_id: A1, period_type: 'weekly', generated_at: hoursAgo(190),
    summary_ar: 'الأسبوع كان هادي، الصرف ثابت تقريباً والطلبات نزلت شوي في الويكند.',
    metrics: {
      kind: 'weekly_performance', currency_code: 'SAR',
      totals: { this_week: { cost: 1105, conversions: 13 }, prior_week: { cost: 1150, conversions: 15 }, delta: { cost: -45, conversions: -2, cpa_this: 85, cpa_prior: 76.7 } },
      highlights_ar: ['الطلبات نزلت يوم الجمعة والسبت'],
      next_week_ar: null,
    },
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000004', account_id: A1, period_type: 'monthly', generated_at: hoursAgo(700),
    summary_ar: 'ملخص الشهر الماضي محفوظ.',
    metrics: { kind: 'audit_summary', health_score: 64, recommendations_count: 6, estimated_monthly_waste_sar: 0, currency_code: 'SAR' },
  },
];
const pageInvoices = [
  { invoice_number: 'INV-0003', amount_sar: 1200, currency: 'SAR', status: 'paid', invoice_url: 'https://example.com/invoice/3', created_at: hoursAgo(120) },
  { invoice_number: 'INV-0002', amount_sar: 1200, currency: 'SAR', status: 'paid', invoice_url: 'https://example.com/invoice/2', created_at: hoursAgo(120 + 720) },
  { invoice_number: 'INV-0001', amount_sar: 500, currency: 'SAR', status: 'paid', invoice_url: null, created_at: hoursAgo(120 + 1440) },
];
SCENARIOS.pages = () => ({
  ...SCENARIOS.home(),
  campaigns_cache: pageCampaigns,
  reports: pageReports,
  invoices: pageInvoices,
  subscriptions: [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', user_id: UID, plan: 'growth', billing_period: 'monthly', status: 'active',
    stripe_subscription_id: 'sub_mock_123', stripe_customer_id: 'cus_mock_123', trial_ends_at: null,
    current_period_start: hoursAgo(120), current_period_end: new Date(Date.now() + 25 * 864e5).toISOString(), created_at: hoursAgo(1500), canceled_at: null,
  }],
});
SCENARIOS['pages-new'] = () => ({
  ...SCENARIOS.home(),
  campaigns_cache: [], reports: [], invoices: [], subscriptions: [],
});
// ===== END restyle-pages block =====
