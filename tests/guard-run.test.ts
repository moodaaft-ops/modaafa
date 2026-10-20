import assert from 'node:assert/strict';
import test from 'node:test';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { EMPTY_FACTS } from '../lib/lifecycle/types';
import { isGuardEnabled, isGuardEnabledForUser, guardMode } from '../lib/guard/flag';
import { guardFactsFrom } from '../lib/guard/notify';
import { reconcile, type GuardStore, type StoredFinding } from '../lib/guard/persist';
import { guardCardLines, readOpenGuardFindings } from '../lib/guard/read';
import { runGuard } from '../lib/guard/run';
import { sendTemplate, type SendTemplateInput } from '../lib/messaging/send';
import { addDaysYmd } from '../lib/guard/time';
import { fakeDb } from './support/guard-db';
import { NOW, YESTERDAY, campaignRows, flat } from './support/guard';

test('flag: off by default, "true" for all, "operators" for operators and the allowlist only', () => {
  assert.equal(guardMode({}), 'off');
  assert.equal(guardMode({ GUARD_ENABLED: 'false' }), 'off');
  assert.equal(guardMode({ GUARD_ENABLED: 'TRUE' }), 'all');
  assert.equal(isGuardEnabled({}), false);
  assert.equal(isGuardEnabled({ GUARD_ENABLED: 'operators' }), true);
  assert.equal(isGuardEnabledForUser('a@x.com', {}), false);
  assert.equal(isGuardEnabledForUser('a@x.com', { GUARD_ENABLED: 'true' }), true);
  const env = { GUARD_ENABLED: 'operators', MODAAFA_OPERATOR_EMAILS: 'op@x.com', GUARD_ALLOWLIST: 'Friend@x.com' };
  assert.equal(isGuardEnabledForUser('OP@x.com', env), true);
  assert.equal(isGuardEnabledForUser('friend@x.com', env), true);
  assert.equal(isGuardEnabledForUser('other@x.com', env), false);
  assert.equal(isGuardEnabledForUser(null, env), false);
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
class MemoryStore implements GuardStore {
  rows: StoredFinding[] = [];
  loads = 0;
  async loadExisting(accountId: string) {
    this.loads += 1;
    return this.rows.filter((r) => r.account_id === accountId && (r.status === 'open' || r.status === 'dismissed'));
  }
  async apply({ accountId, plan, now }: Parameters<GuardStore['apply']>[0]) {
    for (const f of plan.upsert) {
      this.rows = this.rows.filter((r) => !(r.account_id === accountId && r.dedupe_key === f.dedupeKey));
      this.rows.push({
        id: `f${this.rows.length + 1}-${f.dedupeKey}`,
        account_id: accountId,
        code: f.code,
        dedupe_key: f.dedupeKey,
        severity: f.severity,
        status: 'open',
        first_seen_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        seen_count: 1,
        notified_at: null,
        what_ar: f.whatAr,
        step_ar: f.stepAr,
        evidence: f.evidence,
        cause: f.cause as any,
        escalation: f.escalation,
        entity_name: f.entityName,
      });
    }
    for (const t of plan.touch) {
      const row = this.rows.find((r) => r.id === t.id)!;
      row.seen_count = t.seenCount;
      row.last_seen_at = now.toISOString();
    }
    for (const id of plan.resolve) this.rows.find((r) => r.id === id)!.status = 'resolved';
  }
  async listNotifiable(accountIds: string[], now: Date) {
    const { isNotifiable } = await import('../lib/guard/persist');
    return this.rows.filter((r) => accountIds.includes(r.account_id) && isNotifiable(r, now));
  }
  async markNotified(ids: string[], now: Date) {
    for (const row of this.rows) if (ids.includes(row.id)) row.notified_at = now.toISOString();
  }
}

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  business_id: 'biz-1',
  customer_id: '123-456-7890',
  customer_name: 'متجر الورد',
  manager_id: null,
  currency_code: 'SAR',
  time_zone: 'Asia/Riyadh',
  refresh_token_encrypted: 'x',
  google_status: 'ENABLED',
  status: 'active',
  guard_checked_at: null,
  is_manager: false,
  ...over,
});
const tables = (accounts = [account()]) => ({
  businesses: [{ id: 'biz-1', user_id: 'u-1' }, { id: 'biz-2', user_id: 'u-2' }],
  users: [
    { id: 'u-1', email: 'owner@example.com', name: 'سلمان', messages_opt_out: false },
    { id: 'u-2', email: 'op@example.com', name: 'مشغل', messages_opt_out: false },
  ],
  google_ads_accounts: accounts,
  ai_actions: [] as any[],
});

/** A Google Ads reader that answers each of the guard's queries from fixtures. */
function reader(answers: { daily?: any[]; ads?: any[]; status?: string; setups?: any[] } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async query(gaql: string): Promise<any[]> {
      calls.push(gaql);
      if (gaql.includes('FROM customer')) return [{ customer: { status: answers.status ?? 'ENABLED' } }];
      if (gaql.includes('search_impression_share')) return [];
      if (gaql.includes('metrics.cost_micros')) return answers.daily ?? [];
      if (gaql.includes('FROM ad_group_ad')) return answers.ads ?? [];
      if (gaql.includes('FROM billing_setup')) return answers.setups ?? [{ billingSetup: { status: 'APPROVED' } }];
      return [];
    },
  };
}

/** Raw REST rows for one campaign: 14 steady days then `yesterday`. */
function restDaily(id: string, name: string, baseline: number, yesterday: number, shiftDays = 0) {
  return campaignRows(id, name, { baseline: flat(baseline), yesterday }).map((r) => ({
    campaign: { id: r.campaignId, name: r.campaignName },
    segments: { date: addDaysYmd(r.date, shiftDays) },
    metrics: { costMicros: String(r.cost * 1_000_000), conversions: r.conversions, clicks: r.clicks, impressions: r.impressions },
  }));
}

const env = { GUARD_ENABLED: 'true' };
const ids = async () => ['biz-1', 'biz-2'];
function sender() {
  const sent: SendTemplateInput[] = [];
  return {
    sent,
    send: async (input: SendTemplateInput) => {
      sent.push(input);
      return { status: 'sent' as const };
    },
  };
}

test('flag off: the run reads nothing, writes nothing, sends nothing', async () => {
  const db = fakeDb(tables());
  const store = new MemoryStore();
  const mail = sender();
  const customer = reader();
  for (const e of [{}, { GUARD_ENABLED: 'false' }, { GUARD_ENABLED: 'no' }]) {
    const summary = await runGuard(
      { supabase: db, env: e, now: NOW, store, openCustomer: () => customer, billableBusinessIds: ids, sendTemplate: mail.send },
      { force: true }
    );
    assert.equal(summary.skipped, 'disabled');
  }
  assert.deepEqual(db.reads, []);
  assert.equal(db.updates.length, 0);
  assert.equal(store.loads, 0);
  assert.equal(customer.calls.length, 0);
  assert.equal(mail.sent.length, 0);
});

test('operators mode: only the allowed owner is read', async () => {
  const db = fakeDb(tables([account(), account({ id: 'acc-2', business_id: 'biz-2', customer_id: '999' })]));
  const customer = reader();
  const summary = await runGuard(
    {
      supabase: db,
      env: { GUARD_ENABLED: 'operators', MODAAFA_OPERATOR_EMAILS: 'op@example.com' },
      now: NOW,
      store: new MemoryStore(),
      openCustomer: () => customer,
      billableBusinessIds: ids,
      sendTemplate: sender().send,
    },
    {}
  );
  assert.equal(summary.accounts.considered, 1);
  assert.equal(summary.accounts.checked, 1);
});

test('a full run: finds the stopped spend, keeps it once, mails the owner once, and a second run is silent', async () => {
  const db = fakeDb(tables());
  const store = new MemoryStore();
  const mail = sender();
  const customer = reader({ daily: restDaily('1', 'بحث عام', 100, 0) });
  const deps = { supabase: db, env, now: NOW, store, openCustomer: () => customer, billableBusinessIds: ids, sendTemplate: mail.send };

  const first = await runGuard(deps, {});
  assert.equal(first.accounts.checked, 1);
  assert.equal(first.findings.opened, 1);
  assert.equal(store.rows[0].code, 'spend_zero');
  assert.equal(store.rows[0].severity, 'critical');
  assert.equal((store.rows[0].cause as any).code, 'unknown');
  assert.equal(first.mail.sent, 1);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].copy.key, 'guard_alert');
  assert.equal(mail.sent[0].templateKey, 'guard_alert_2026-10-19');
  assert.equal(mail.sent[0].enforceGap, false);
  assert.equal(mail.sent[0].user.email, 'owner@example.com');
  assert.equal(mail.sent[0].facts.guard?.hasCritical, true);
  assert.ok(store.rows[0].notified_at);
  assert.ok(db.tables.google_ads_accounts[0].guard_checked_at);

  // The next day's run sees the same thing: touched, not re-sent.
  const next = new Date(NOW.getTime() + 24 * 3_600_000);
  const second = await runGuard({ ...deps, now: next }, {});
  assert.equal(second.findings.opened, 0);
  assert.equal(second.findings.touched, 1);
  assert.equal(store.rows[0].seen_count, 2);
  assert.equal(mail.sent.length, 1);
  assert.equal(second.mail.owners, 0);
});

test('a run that is repeated the same day skips accounts already checked (the scheduler safety slot)', async () => {
  const db = fakeDb(tables());
  const customer = reader();
  const deps = { supabase: db, env, now: NOW, store: new MemoryStore(), openCustomer: () => customer, billableBusinessIds: ids, sendTemplate: sender().send };
  await runGuard(deps, {});
  const again = await runGuard({ ...deps, now: new Date(NOW.getTime() + 3_600_000) }, {});
  assert.equal(again.accounts.skippedRecent, 1);
  assert.equal(again.accounts.checked, 0);
  const forced = await runGuard({ ...deps, now: new Date(NOW.getTime() + 3_600_000) }, { force: true });
  assert.equal(forced.accounts.checked, 1);
});

test('a finding that stops being true is closed, and an unreadable read does not close it', async () => {
  const db = fakeDb(tables());
  const store = new MemoryStore();
  const deps = { supabase: db, env, now: NOW, store, billableBusinessIds: ids, sendTemplate: sender().send };
  await runGuard({ ...deps, openCustomer: () => reader({ daily: restDaily('1', 'بحث عام', 100, 0) }) }, {});
  assert.equal(store.rows[0].status, 'open');

  // Daily read throws: unknown, the finding stays open.
  const broken = { calls: [] as string[], async query(gaql: string): Promise<any[]> { if (gaql.includes('metrics.cost_micros')) throw new Error('boom'); return reader().query(gaql); } };
  await runGuard({ ...deps, now: new Date(NOW.getTime() + 24 * 3_600_000), openCustomer: () => broken }, {});
  assert.equal(store.rows[0].status, 'open');

  // Spending again: resolved.
  await runGuard({ ...deps, now: new Date(NOW.getTime() + 48 * 3_600_000), openCustomer: () => reader({ daily: restDaily('1', 'بحث عام', 100, 100, 2) }) }, {});
  assert.equal(store.rows[0].status, 'resolved');
});

test('a paused link whose account Google reports closed becomes a critical finding without asking Google', async () => {
  const db = fakeDb(tables([account({ status: 'paused', google_status: 'CUSTOMER_NOT_ENABLED' }), account({ id: 'acc-3', status: 'paused', google_status: null }), account({ id: 'acc-4', status: 'revoked', google_status: 'SUSPENDED' })]));
  const store = new MemoryStore();
  const customer = reader();
  const summary = await runGuard(
    { supabase: db, env, now: NOW, store, openCustomer: () => customer, billableBusinessIds: ids, sendTemplate: sender().send },
    {}
  );
  assert.equal(summary.accounts.considered, 1);
  assert.equal(customer.calls.length, 0);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].code, 'account_status');
  assert.equal(store.rows[0].escalation, 'human');
});

test('one account failing does not stop the others or mark it checked', async () => {
  const db = fakeDb(tables([account(), account({ id: 'acc-2', customer_id: '555' })]));
  const store = new MemoryStore();
  const summary = await runGuard(
    {
      supabase: db,
      env,
      now: NOW,
      store,
      openCustomer: (a) => {
        if (a.id === 'acc-1') throw new Error('token unreadable');
        return reader();
      },
      billableBusinessIds: ids,
      sendTemplate: sender().send,
    },
    {}
  );
  assert.equal(summary.accounts.failed, 1);
  assert.equal(summary.accounts.checked, 1);
  assert.equal(db.tables.google_ads_accounts[0].guard_checked_at, null);
  assert.ok(db.tables.google_ads_accounts[1].guard_checked_at);
});

test('the time budget stops a run early and reports it', async () => {
  const db = fakeDb(tables());
  const summary = await runGuard(
    { supabase: db, env, now: NOW, store: new MemoryStore(), openCustomer: () => reader(), billableBusinessIds: ids, sendTemplate: sender().send, budget: { expired: () => true } },
    {}
  );
  assert.equal(summary.accounts.skippedForTime, 1);
  assert.equal(summary.accounts.checked, 0);
});

test('mail not approved: the real gate skips it, nothing is marked sent, the finding stays for later', async () => {
  const db = fakeDb(tables());
  const store = new MemoryStore();
  const gated = {
    send: (input: SendTemplateInput) => sendTemplate(input, { supabase: {}, emailConfigured: () => true }),
  };
  const summary = await runGuard(
    { supabase: db, env, now: NOW, store, openCustomer: () => reader({ daily: restDaily('1', 'بحث عام', 100, 0) }), billableBusinessIds: ids, sendTemplate: gated.send },
    {}
  );
  assert.equal(EMAIL_COPY.guard_alert.approved, false);
  assert.deepEqual(summary.mail.skipped, { not_approved: 1 });
  assert.equal(summary.mail.sent, 0);
  assert.equal(store.rows[0].notified_at, null);
  assert.equal(store.rows[0].status, 'open');
});

test('escalation: a policy finding is marked for a person, and the mail says so', async () => {
  const db = fakeDb(tables());
  const store = new MemoryStore();
  const mail = sender();
  await runGuard(
    {
      supabase: db,
      env,
      now: NOW,
      store,
      openCustomer: () =>
        reader({
          ads: [{ adGroupAd: { ad: { id: '11' }, policySummary: { approvalStatus: 'DISAPPROVED', policyTopicEntries: [{ topic: 'DESTINATION_NOT_WORKING' }] } }, campaign: { id: '1', name: 'بحث عام' } }],
        }),
      billableBusinessIds: ids,
      sendTemplate: mail.send,
    },
    {}
  );
  assert.equal(store.rows[0].code, 'ad_policy');
  assert.equal(store.rows[0].escalation, 'human');
  assert.equal(mail.sent[0].facts.guard?.escalate, true);
});

// ---------------------------------------------------------------------------
// Email copy
// ---------------------------------------------------------------------------
const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  id: '1',
  account_id: 'acc-1',
  code: 'spend_zero',
  dedupe_key: 'k',
  severity: 'critical',
  status: 'open',
  first_seen_at: NOW.toISOString(),
  last_seen_at: NOW.toISOString(),
  seen_count: 1,
  notified_at: null,
  what_ar: 'حسابك ما صرف شي أمس، وعادةً يصرف حوالي 140 ر.س باليوم',
  step_ar: 'افحص الفوترة وحالة الحملات والإعلانات المرفوضة',
  evidence: {},
  cause: { code: 'billing', labelAr: 'ما فيه إعداد دفع فعّال لحسابك الإعلاني عند قوقل' },
  escalation: 'human',
  entity_name: null,
  ...over,
});

test('mail facts: worst first, no info lines, an unknown cause is not printed', () => {
  const facts = guardFactsFrom(
    [stored({ id: '2', severity: 'medium', cause: { code: 'unknown', labelAr: 'ما لقيت' } }), stored(), stored({ id: '3', severity: 'info' })],
    false
  );
  assert.ok(facts);
  assert.equal(facts.items.length, 2);
  assert.equal(facts.items[0].severity, 'critical');
  assert.equal(facts.items[1].causeAr, null);
  assert.equal(facts.hasCritical, true);
  assert.equal(guardFactsFrom([stored({ severity: 'info' })], false), null);
});

test('guard_alert copy: nothing to say gives nothing, a critical gets an urgent subject, the list is capped', () => {
  const copy = EMAIL_COPY.guard_alert;
  assert.equal(copy.build(EMPTY_FACTS), null);
  assert.equal(copy.build({ ...EMPTY_FACTS, guard: { items: [], hasCritical: false, escalate: false } }), null);
  const item = (n: number) => ({ severity: 'medium' as const, whatAr: `حملة رقم ${n} ما صرفت شي أمس`, stepAr: 'افحص الحملة', causeAr: null, accountName: null });
  const mail = copy.build({ ...EMPTY_FACTS, guard: { items: Array.from({ length: 7 }, (_, i) => item(i)), hasCritical: false, escalate: true } })!;
  assert.equal(mail.subject, 'وش صار في حسابك الإعلاني أمس');
  const list = mail.blocks.find((b) => b.type === 'list') as { items: string[] };
  assert.equal(list.items.length, 5);
  assert.ok(mail.blocks.some((b) => b.type === 'p' && /2 تنبيهات ثانية/.test(b.text)));
  assert.ok(mail.blocks.some((b) => b.type === 'note'));
  const urgent = copy.build({ ...EMPTY_FACTS, guard: { items: [{ ...item(1), severity: 'critical' }], hasCritical: true, escalate: false } })!;
  assert.equal(urgent.subject, 'تنبيه عاجل على حسابك الإعلاني');
  assert.equal(urgent.cta?.path, '/home');
  assert.ok(urgent.preheader.length <= 90 && urgent.subject.length <= 70);
});

// ---------------------------------------------------------------------------
// Read side: home and Jarvis
// ---------------------------------------------------------------------------
test('home and Jarvis: open findings, worst first, only for owners the flag allows', async () => {
  const db = fakeDb({
    guard_findings: [
      { id: '1', account_id: 'acc-1', code: 'ad_policy', severity: 'medium', status: 'open', what_ar: 'إعلان محدود', step_ar: 'راجع', cause: null, escalation: 'human', first_seen_at: '2026-10-19T02:00:00Z' },
      { id: '2', account_id: 'acc-1', code: 'spend_zero', severity: 'critical', status: 'open', what_ar: 'ما صرف', step_ar: 'افحص', cause: { code: 'billing', labelAr: 'الدفع' }, escalation: 'none', first_seen_at: '2026-10-19T02:10:00Z' },
      { id: '3', account_id: 'acc-1', code: 'outside_change', severity: 'info', status: 'open', what_ar: 'تعديل', step_ar: 'x', cause: null, escalation: 'none', first_seen_at: '2026-10-19T02:10:00Z' },
      { id: '4', account_id: 'acc-1', code: 'spend_spike', severity: 'high', status: 'resolved', what_ar: 'قديم', step_ar: 'x', cause: null, escalation: 'none', first_seen_at: '2026-10-18T02:10:00Z' },
      { id: '5', account_id: 'acc-2', code: 'spend_spike', severity: 'high', status: 'open', what_ar: 'غيره', step_ar: 'x', cause: null, escalation: 'none', first_seen_at: '2026-10-18T02:10:00Z' },
    ],
  });
  const open = await readOpenGuardFindings(db, 'acc-1');
  assert.deepEqual(open.map((f) => f.id), ['2', '1']);
  assert.equal(open[0].causeAr, 'الدفع');

  assert.deepEqual(await guardCardLines(db, 'acc-1', 'owner@example.com', {}), []);
  assert.deepEqual(await guardCardLines(db, null, 'owner@example.com', env), []);
  const lines = await guardCardLines(db, 'acc-1', 'owner@example.com', env);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /\[critical\] ما صرف \| السبب المحتمل: الدفع \| الخطوة: افحص/);
  // The table missing (migration not applied) reads as nothing.
  assert.deepEqual(await readOpenGuardFindings({ from: () => { throw new Error('no table'); } }, 'acc-1'), []);
});

test('reconcile is what keeps a repeat quiet: the run test above relies on it', () => {
  assert.equal(YESTERDAY, '2026-10-18');
  assert.equal(reconcile([], [], { status: true, daily: true, campaigns: true, ads: true, billing: true, changes: true }).upsert.length, 0);
});
