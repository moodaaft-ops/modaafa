import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, planApply, planTurn } from '../lib/chat-first/orchestrator';
import { isChatFirstEnabled } from '../lib/chat-first/flag';
import { loadChatState } from '../lib/chat-first/state';
import type { ChatRecommendation, ChatState } from '../lib/chat-first/contracts';

const rec = (over: Partial<ChatRecommendation> = {}): ChatRecommendation => ({
  id: 'r1',
  title: 'أوقف كلمة تصرف ولا تبيع',
  description: 'الكلمة صرفت ولا جابت تحويل',
  severity: 'critical',
  status: 'pending',
  executable: true,
  ...over,
});

const base = (over: Partial<ChatState> = {}): ChatState => ({
  accountLinked: true,
  accountName: 'متجر الأمل',
  customerId: '1234567890',
  latestAudit: {
    id: 'a1',
    healthScore: 62,
    findingsCount: 7,
    estimatedMonthlyWaste: 340,
    ranAt: '2026-10-08T10:00:00Z',
  },
  recommendations: [rec()],
  subscriptionActive: false,
  ...over,
});

const labels = (t: ReturnType<typeof planTurn>) => t.actions.map((a) => a.action.type);

test('flag is off unless exactly "true"', () => {
  assert.equal(isChatFirstEnabled({}), false);
  assert.equal(isChatFirstEnabled({ CHAT_FIRST_ENTRY: '1' }), false);
  assert.equal(isChatFirstEnabled({ CHAT_FIRST_ENTRY: 'true' }), true);
});

test('beginner phrases map to the right intent', () => {
  assert.equal(classify('ابي افحص حسابي'), 'run_audit');
  assert.equal(classify('وش وضع حسابي'), 'show_result');
  assert.equal(classify('وش اسوي عشان يتحسن'), 'recommend');
  assert.equal(classify('طبق التوصية'), 'apply');
  assert.equal(classify('اعد الفحص من جديد'), 'rerun');
  assert.equal(classify('هلا'), 'ambiguous');
  assert.equal(classify('   '), 'ambiguous');
});

test('no linked account: says so, offers connect, shows no numbers or cards', () => {
  const t = planTurn('وش وضع حسابي', base({ accountLinked: false, customerId: null, latestAudit: null, recommendations: [] }));
  assert.deepEqual(labels(t), ['connect_account']);
  assert.equal(t.cards.length, 0);
  assert.match(t.reply, /ما عندي حساب/);
});

test('apply with no account never offers approve or execute', () => {
  const t = planTurn('طبق التوصية', base({ accountLinked: false, customerId: null, latestAudit: null, recommendations: [] }));
  assert.ok(!labels(t).includes('approve'));
  assert.ok(!labels(t).includes('execute'));
});

test('linked account without an audit: no invented results, offers the free audit', () => {
  const t = planTurn('وش وضع حسابي', base({ latestAudit: null, recommendations: [] }));
  assert.equal(t.cards.length, 0);
  assert.deepEqual(labels(t), ['run_audit']);
  assert.match(t.reply, /ما فيه فحص/);
});

test('result card carries only the real audit numbers', () => {
  const t = planTurn('وش وضع حسابي', base());
  const card = t.cards[0];
  assert.equal(card.kind, 'audit_result');
  if (card.kind === 'audit_result') {
    assert.equal(card.healthScore, 62);
    assert.equal(card.findingsCount, 7);
    assert.equal(card.estimatedMonthlyWaste, 340);
  }
  assert.match(t.reply, /62 من 100/);
});

test('recommendation preview changes nothing and offers apply', () => {
  const t = planTurn('وش التوصيات', base());
  assert.equal(t.cards[0].kind, 'recommendation');
  assert.ok(labels(t).includes('request_apply'));
  assert.ok(!labels(t).includes('approve'));
  assert.ok(!labels(t).includes('execute'));
});

test('unauthorized apply: no subscription gives a subscription card and no approve button', () => {
  const t = planTurn('طبق التوصية', base({ subscriptionActive: false }));
  assert.ok(t.cards.some((c) => c.kind === 'subscription_required'));
  assert.deepEqual(labels(t).filter((x) => x === 'approve' || x === 'execute'), []);
  assert.ok(labels(t).includes('subscribe'));
});

test('subscriber: apply asks for explicit approval first, never executes directly', () => {
  const t = planTurn('طبق التوصية', base({ subscriptionActive: true }));
  assert.ok(t.cards.some((c) => c.kind === 'approval'));
  assert.deepEqual(labels(t), ['approve']);
});

test('subscriber with an already approved recommendation gets the execute step', () => {
  const t = planApply(base({ subscriptionActive: true }), rec({ status: 'approved' }));
  assert.deepEqual(labels(t), ['execute']);
});

test('non executable recommendation is sent to manual review, not approved', () => {
  const t = planApply(base({ subscriptionActive: true }), rec({ executable: false }));
  assert.ok(!labels(t).includes('approve'));
  assert.match(t.reply, /مراجعة يدوية/);
});

test('ambiguous request asks a question and offers choices instead of acting', () => {
  const t = planTurn('هلا', base({ subscriptionActive: true }));
  assert.equal(t.intent, 'ambiguous');
  assert.ok(!labels(t).includes('approve'));
  assert.ok(!labels(t).includes('execute'));
  assert.ok(t.actions.length >= 2);
});

test('replies avoid the banned punctuation', () => {
  const samples = [
    planTurn('وش وضع حسابي', base()),
    planTurn('طبق', base()),
    planTurn('هلا', base()),
    planTurn('x', base({ accountLinked: false, customerId: null })),
  ];
  for (const s of samples) assert.doesNotMatch(s.reply, /[—–,]/);
});

// ---- cross-account access, against a fake RLS-less store that filters by eq ----
type Row = Record<string, any>;
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])];
      const q: any = {
        select: () => q,
        eq: (c: string, v: any) => ((rows = rows.filter((r) => r[c] === v)), q),
        in: (c: string, vs: any[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
        not: (c: string, _op: string, v: any) => ((rows = rows.filter((r) => r[c] !== v)), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (res: any) => res({ data: rows, error: null }),
      };
      return q;
    },
  };
}

const world = {
  businesses: [
    { id: 'bA', user_id: 'userA', created_at: '1' },
    { id: 'bB', user_id: 'userB', created_at: '1' },
  ],
  google_ads_accounts: [
    { id: 'accA', business_id: 'bA', customer_id: '1111111111', customer_name: 'متجر أ', status: 'active' },
    { id: 'accB', business_id: 'bB', customer_id: '2222222222', customer_name: 'متجر ب', status: 'active' },
  ],
  audits: [{ id: 'auB', account_id: 'accB', health_score: 10, findings: [{}], estimated_monthly_waste: 1, ran_at: 'x' }],
  recommendations: [{ id: 'rB', account_id: 'accB', title: 'سري', status: 'pending', action_payload: {} }],
  subscriptions: [],
};

test('user A naming user B account id gets account_not_found and no data', async () => {
  const r = await loadChatState({
    supabase: fakeSupabase(world),
    userId: 'userA',
    requestedCustomerId: '222-222-2222',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'account_not_found');
});

test('user A with no explicit id only ever sees their own account data', async () => {
  const r = await loadChatState({ supabase: fakeSupabase(world), userId: 'userA' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.state.customerId, '1111111111');
    assert.equal(r.state.latestAudit, null);
    assert.equal(r.state.recommendations.length, 0);
  }
});

test('stale cookie pointing at another users account falls back to own account, not theirs', async () => {
  const r = await loadChatState({
    supabase: fakeSupabase(world),
    userId: 'userA',
    cookieCustomerId: '2222222222',
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.customerId, '1111111111');
});

test('a user with no business gets the connect state, not an error', async () => {
  const r = await loadChatState({ supabase: fakeSupabase(world), userId: 'ghost' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.state.accountLinked, false);
});
