// Fake Supabase (auth + REST) for tests/e2e/mobile-layout.spec.ts. Synthetic data only, never a real account.
// Run: node tests/e2e/support/mock-supabase.mjs  (listens on 127.0.0.1:54321)
import http from 'node:http';
const UID = '11111111-1111-4111-8111-111111111111';
const BID = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const AUD = '55555555-5555-4555-8555-555555555555';
const now = new Date().toISOString();
const long = 'حملة البحث العامة لمتجر العبايات الفاخرة والأزياء النسائية الموسمية في منطقة الرياض وجدة والدمام مع كلمات مفتاحية طويلة جداً';
const user = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'qa-tester@example.com', app_metadata: {}, user_metadata: {}, created_at: now };
const recs = ['critical', 'medium', 'growth', 'critical'].map((s, i) => ({
  id: `66666666-6666-4666-8666-66666666660${i}`, audit_id: AUD, account_id: A1, category: ['budget', 'keywords', 'ads', 'bidding'][i], severity: s,
  title: i === 0 ? 'إضافة كلمات سلبية للبحث عن عبايات مستعملة ورخيصة وبالجملة حتى لا تُهدر الميزانية على نقرات لا تشتري' : 'تخفيض ميزانية حملة الأداء الأقل مردوداً',
  description: 'وصف طويل للتوصية يشرح السبب ويذكر الأرقام التي استندت إليها ' + long,
  expected_impact: { monthly_savings: 1250, summary_ar: 'توفير متوقع يصل إلى ١٬٢٥٠ ر.س شهرياً' },
  action_payload: { type: 'add_negative_keyword', keywords: ['مستعمل', 'رخيص', 'بالجملة', 'مجاني'], campaign_id: '123', campaign_name: long },
  status: i === 3 ? 'applied' : 'pending', created_at: now,
}));
const tables = {
  users: [{ id: UID, email: user.email, name: 'مستخدم تجريبي', preferred_lang: 'ar' }],
  businesses: [{ id: BID, user_id: UID, name: 'متجر العبايات الفاخرة للأزياء النسائية', sector: 'ecommerce', website: 'https://example.com', monthly_budget: 5000, primary_goal: 'conversions', target_regions: ['الرياض', 'جدة'], selected_google_ads_customer_id: '1234567890' }],
  google_ads_accounts: [
    { id: A1, business_id: BID, customer_id: '1234567890', customer_name: long, manager_id: null, status: 'active', is_manager: false, google_status: 'ENABLED', currency_code: 'SAR', time_zone: 'Asia/Riyadh', last_synced_at: now, linked_at: now },
    { id: A2, business_id: BID, customer_id: '9876543210', customer_name: 'حساب ثانٍ', status: 'revoked', is_manager: false, google_status: 'ENABLED', currency_code: 'SAR', time_zone: 'Asia/Riyadh', last_synced_at: now, linked_at: now },
  ],
  audits: [{ id: AUD, account_id: A1, health_score: 62, category_scores: { bidding: 70, keywords: 55, ads: 60, structure: 65, budget: 58 }, findings: [{ title: 'نتيجة', severity: 'critical' }], metrics_snapshot: { cost: 4200, clicks: 3100, impressions: 90000, conversions: 120 }, estimated_monthly_waste: 1250.5, ran_at: now, duration_ms: 1800 }],
  recommendations: recs,
  ai_actions: [{ id: '77777777-7777-4777-8777-777777777777', account_id: A1, action_type: 'add_negative_keyword', description_ar: 'أضيفت كلمة سلبية: ' + long, expected_impact: { monthly_savings: 300 }, observed_impact: null, result: { ok: true }, rollback_payload: { x: 1 }, rollback_status: null, reverted_at: null, created_at: now }],
  campaigns_cache: [0, 1, 2].map((i) => ({ id: `88888888-8888-4888-8888-88888888880${i}`, account_id: A1, google_campaign_id: 1000 + i, name: i === 0 ? long : 'حملة ' + i, type: ['SEARCH', 'PMAX', 'SHOPPING'][i], status: 'ENABLED', daily_budget: 150.5, bidding_strategy: 'MAXIMIZE_CONVERSIONS', metrics_today: { cost: 120.4, clicks: 85, impressions: 2400, conversions: 4, ctr: 0.035, conversion_value: 900 }, last_synced_at: now })),
  reports: [{ id: '99999999-9999-4999-8999-999999999999', account_id: A1, period_type: 'weekly', period_start: '2026-10-01', period_end: '2026-10-07', summary_ar: 'ملخص أسبوعي طويل. ' + long.repeat(3), metrics: { kind: 'weekly', cost: 4200, clicks: 3100, conversions: 120 }, forecast: null, generated_at: now }],
  subscriptions: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: UID, plan: 'growth', billing_period: 'monthly', status: 'active', trial_ends_at: null, current_period_start: now, current_period_end: new Date(Date.now() + 20 * 864e5).toISOString(), created_at: now, canceled_at: null }],
  invoices: [{ invoice_number: 'INV-1001', amount_sar: 299, currency: 'SAR', status: 'paid', invoice_url: null, created_at: now }],
  autopilot_settings: [], autopilot_decisions: [], chat_sessions: [], chat_messages: [], usage_events: [], job_runs: [], sector_benchmarks: [],
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...h }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204, {}, { 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
  if (u.pathname === '/auth/v1/user') return send(200, user);
  if (u.pathname.startsWith('/auth/v1/')) return send(200, {});
  const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
  if (m) {
    const rows = tables[m[1]] ?? [];
    const accept = req.headers.accept || '';
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(201, []);
    const lim = Number(u.searchParams.get('limit') || rows.length);
    const out = rows.slice(0, lim);
    if (accept.includes('vnd.pgrst.object')) return out.length ? send(200, out[0]) : send(406, { code: 'PGRST116', message: 'none', details: '', hint: '' });
    return send(200, out, { 'content-range': `0-${Math.max(out.length - 1, 0)}/${rows.length}` });
  }
  if (u.pathname.startsWith('/rest/v1/rpc/')) return send(200, null);
  send(404, { message: 'mock: ' + u.pathname });
}).listen(54321, '127.0.0.1', () => console.log('mock supabase on 54321'));
