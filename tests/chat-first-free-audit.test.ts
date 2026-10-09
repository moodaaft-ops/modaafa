import assert from 'node:assert/strict';
import test from 'node:test';
import { planTurn } from '../lib/chat-first/orchestrator';
import { freeAuditViewFromLedger, readFreeAuditView } from '../lib/chat-first/free-audit-view';
import type { ChatState } from '../lib/chat-first/contracts';

const base = (over: Partial<ChatState> = {}): ChatState => ({
  accountLinked: true,
  accountName: 'متجر الأمل',
  customerId: '1234567890',
  latestAudit: { id: 'a1', healthScore: 62, findingsCount: 7, estimatedMonthlyWaste: 340, ranAt: '2026-10-08T10:00:00Z' },
  recommendations: [],
  subscriptionActive: false,
  ...over,
});

const types = (t: ReturnType<typeof planTurn>) => t.actions.map((a) => a.action.type);
const NOW = Date.parse('2026-10-09T12:00:00Z');
const future = '2026-10-09T12:10:00Z';
const past = '2026-10-09T11:00:00Z';

test('ledger view: two completed audits means exhausted, one means available', () => {
  assert.equal(freeAuditViewFromLedger([{ status: 'completed' }, { status: 'completed' }], NOW), 'exhausted');
  assert.equal(freeAuditViewFromLedger([{ status: 'completed' }], NOW), 'available');
  assert.equal(freeAuditViewFromLedger([], NOW), 'available');
});

test('ledger view: an abandoned reservation never counts as used', () => {
  const rows = [{ status: 'completed' }, { status: 'reserved', lease_expires_at: past }, { status: 'reserved', lease_expires_at: past }];
  assert.equal(freeAuditViewFromLedger(rows, NOW), 'available');
});

test('ledger view: a live lease is in progress, but two completed still wins', () => {
  assert.equal(freeAuditViewFromLedger([{ status: 'reserved', lease_expires_at: future }], NOW), 'in_progress');
  const rows = [{ status: 'completed' }, { status: 'completed' }, { status: 'reserved', lease_expires_at: future }];
  assert.equal(freeAuditViewFromLedger(rows, NOW), 'exhausted');
});

test('reader: scopes the query to the customer and reads the answer', async () => {
  const seen: Record<string, unknown> = {};
  const admin = {
    from: (t: string) => {
      seen.table = t;
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => ((seen[k] = v), q),
        in: () => Promise.resolve({ data: [{ status: 'completed' }, { status: 'completed' }], error: null }),
      };
      return q;
    },
  };
  assert.equal(await readFreeAuditView('1234567890', admin), 'exhausted');
  assert.equal(seen.table, 'free_audit_ledger');
  assert.equal(seen.customer_id, '1234567890');
});

test('reader: any failure is unknown, never exhausted', async () => {
  const failing = { from: () => ({ select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'relation does not exist' } }) }) }) }) };
  const throwing = { from: () => { throw new Error('no env'); } };
  assert.equal(await readFreeAuditView('1', failing), 'unknown');
  assert.equal(await readFreeAuditView('1', throwing), 'unknown');
});

test('exhausted free account: asking for an audit gets subscribe, not a button that ends in 402', () => {
  for (const msg of ['ابي افحص حسابي', 'اعد الفحص من جديد']) {
    const t = planTurn(msg, base({ freeAudit: 'exhausted' }));
    assert.ok(!types(t).includes('run_audit'), msg);
    assert.ok(types(t).includes('subscribe'), msg);
    assert.match(t.reply, /القراءة والشرح تبقى مجانية/);
  }
});

test('exhausted free account: reading the last result still works', () => {
  const t = planTurn('وش وضع حسابي', base({ freeAudit: 'exhausted' }));
  assert.equal(t.intent, 'show_result');
  assert.equal(t.cards.length > 0, true);
});

test('unknown or missing allowance behaves as before: the audit route decides', () => {
  for (const freeAudit of [undefined, 'unknown', 'available'] as const) {
    const t = planTurn('ابي افحص حسابي', base({ latestAudit: null, ...(freeAudit ? { freeAudit } : {}) }));
    assert.ok(types(t).includes('run_audit'), String(freeAudit));
    assert.ok(!types(t).includes('subscribe'), String(freeAudit));
  }
});

test('audit already running: no second run button, offers to check the status', () => {
  const t = planTurn('ابي افحص حسابي', base({ freeAudit: 'in_progress' }));
  assert.ok(!types(t).includes('run_audit'));
  assert.ok(types(t).includes('say'));
});

test('a subscriber is never shown the free-ledger states', () => {
  const t = planTurn('ابي افحص حسابي', base({ subscriptionActive: true, freeAudit: 'exhausted' }));
  assert.ok(types(t).includes('run_audit'));
  assert.ok(!types(t).includes('subscribe'));
});
