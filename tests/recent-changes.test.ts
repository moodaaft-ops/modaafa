import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  RECENT_CHANGES_SHOWN,
  ROLLBACK_WINDOW_MS,
  isUndoable,
  loadRecentChanges,
  pickRecentChanges,
  type RecentChangeRow,
} from '../lib/home/recent-changes';
import { HOME_NOTICES, lockedNoticeFrom, noticeFrom } from '../lib/home/briefing';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600e3).toISOString();
const ACCOUNT = 'acc-mine';
const OTHER = 'acc-other';
const CUSTOMER = '123-456-7890';

const row = (over: Partial<RecentChangeRow> = {}): RecentChangeRow => ({
  id: 'a1',
  account_id: ACCOUNT,
  action_type: 'add_negative_keyword',
  description_ar: 'منعت إعلانك يطلع لعبارة «عطور مجانية»',
  created_at: hoursAgo(5),
  reverted_at: null,
  rollback_status: null,
  rollback_payload: { reversible: true, resource_name: 'customers/1234567890/campaignCriteria/1~2' },
  ...over,
});

const pick = (rows: RecentChangeRow[], over: { limit?: number } = {}) =>
  pickRecentChanges(rows, { accountId: ACCOUNT, customerId: CUSTOMER, now: NOW, ...over });

test('a reversible change of this account from the last 30 days is listed with its words and its time', () => {
  const { items, more } = pick([row()]);
  assert.deepEqual(items, [{ id: 'a1', text: 'منعت إعلانك يطلع لعبارة «عطور مجانية»', createdAt: hoursAgo(5) }]);
  assert.equal(more, false);
});

test('rows of another account never reach the list, even if they came back from the read', () => {
  const { items } = pick([row({ id: 'theirs', account_id: OTHER }), row({ id: 'mine' }), row({ id: 'nowhere', account_id: null })]);
  assert.deepEqual(items.map((i) => i.id), ['mine']);
});

test('only what the rollback route would accept gets a button', () => {
  const day = 24 * 3600e3;
  const rows = [
    row({ id: 'ok' }),
    row({ id: 'not-reversible', rollback_payload: { reversible: false, resource_name: 'customers/1234567890/x' } }),
    row({ id: 'no-payload', rollback_payload: null }),
    row({ id: 'already-reverted', reverted_at: hoursAgo(1) }),
    row({ id: 'running', rollback_status: 'executing' }),
    row({ id: 'too-old', created_at: new Date(NOW - 30 * day - 60_000).toISOString() }),
    row({ id: 'foreign-resource', rollback_payload: { reversible: true, resource_name: 'customers/9999999999/campaignCriteria/1~2' } }),
    row({ id: 'no-resource', rollback_payload: { reversible: true } }),
    row({ id: 'bad-date', created_at: 'not a date' }),
  ];
  assert.deepEqual(pick(rows).items.map((i) => i.id), ['ok']);
  // A failed earlier attempt can be tried again (the route allows it).
  assert.equal(isUndoable(row({ rollback_status: 'failed' }), CUSTOMER, NOW), true);
  // Day 30 exactly is still inside the window, like the route.
  assert.equal(isUndoable(row({ created_at: new Date(NOW - 30 * day).toISOString() }), CUSTOMER, NOW), true);
});

test('newest first, at most five, and «more» says there is a longer log', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row({ id: `r${i}`, created_at: hoursAgo(i + 1) }));
  const shuffled = [rows[3], rows[0], rows[6], rows[1], rows[5], rows[2], rows[4]];
  const { items, more } = pick(shuffled);
  assert.equal(items.length, RECENT_CHANGES_SHOWN);
  assert.deepEqual(items.map((i) => i.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(more, true);
  assert.equal(pick(rows.slice(0, 5)).more, false);
  assert.equal(pick(rows.slice(0, 2), { limit: 1 }).more, true);
});

test('a change without words falls back to the operation name, then to a plain line', () => {
  assert.equal(pick([row({ description_ar: '  ', action_type: 'pause_campaign' })]).items[0].text, 'إيقاف حملة');
  assert.equal(pick([row({ description_ar: null, action_type: 'something_new' })]).items[0].text, 'تغيير على حسابك');
  const long = pick([row({ description_ar: 'ي'.repeat(400) })]).items[0].text;
  assert.ok(long.length < 200);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(pick([]), { items: [], more: false });
  assert.deepEqual(pickRecentChanges(null, { accountId: ACCOUNT, customerId: CUSTOMER }), { items: [], more: false });
});

// A query double that records what was asked, the way the real client would send it.
function recordingClient(result: { data?: unknown; error?: unknown } | Error) {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: any = {};
  for (const name of ['select', 'eq', 'is', 'gte', 'order', 'limit']) {
    q[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return name === 'limit' ? Promise.resolve(result instanceof Error ? Promise.reject(result) : { data: null, error: null, ...result }) : q;
    };
  }
  return { client: { from: (table: string) => (calls.push(['from', table]), q) }, calls };
}

test('the read is scoped to the selected account, to reversible rows from the last 30 days, newest first', async () => {
  const { client, calls } = recordingClient({ data: [row(), row({ id: 'theirs', account_id: OTHER })] });
  const result = await loadRecentChanges(client, { accountId: ACCOUNT, customerId: CUSTOMER, now: NOW });
  assert.deepEqual(result.items.map((i) => i.id), ['a1']);

  const asked = (name: string) => calls.filter((c) => c[0] === name);
  assert.deepEqual(asked('from'), [['from', 'ai_actions']]);
  assert.deepEqual(asked('eq'), [
    ['eq', 'account_id', ACCOUNT],
    ['eq', 'rollback_payload->>reversible', 'true'],
  ]);
  assert.deepEqual(asked('is'), [['is', 'reverted_at', null]]);
  assert.deepEqual(asked('gte'), [['gte', 'created_at', new Date(NOW - ROLLBACK_WINDOW_MS).toISOString()]]);
  assert.deepEqual(asked('order'), [['order', 'created_at', { ascending: false }]]);
  // The columns the undo needs, and the payload only to decide; none of it is sent to the browser.
  const selected = String(asked('select')[0][1]);
  for (const column of ['id', 'account_id', 'description_ar', 'created_at', 'reverted_at', 'rollback_status', 'rollback_payload']) {
    assert.ok(selected.includes(column), column);
  }
});

test('a failed or throwing read shows no list instead of breaking /home', async () => {
  const failed = recordingClient({ error: { message: 'boom' } });
  assert.deepEqual(await loadRecentChanges(failed.client, { accountId: ACCOUNT, customerId: CUSTOMER, now: NOW }), { items: [], more: false });
  const thrown = recordingClient(new Error('network'));
  assert.deepEqual(await loadRecentChanges(thrown.client, { accountId: ACCOUNT, customerId: CUSTOMER, now: NOW }), { items: [], more: false });
});

test('the window is the one the rollback route and the approvals screen enforce', () => {
  assert.equal(ROLLBACK_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);
  assert.match(read('app/api/actions/rollback/route.ts'), /ROLLBACK_WINDOW_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(read('app/(dashboard)/optimizer/page.tsx'), /<= 30 \* 24 \* 60 \* 60 \* 1000/);
});

test('«رجّعه» posts to the existing rollback route, behind an in-app confirm, and comes back to /home', () => {
  const view = read('app/(dashboard)/home/recent-changes.tsx');
  assert.match(view, /action="\/api\/actions\/rollback"/);
  assert.match(view, /name="action_id"/);
  assert.match(view, /name="next" value="\/home"/);
  assert.match(view, /ترجّع هذا التعديل؟/);
  assert.match(view, /رجّعه/);
  // No second rollback path: the component does not fetch or write anything itself.
  assert.doesNotMatch(view, /fetch\(|supabase|rollback_payload/);
  assert.doesNotMatch(view, /[—–]/);
});

test('/home lists the undo for people with a plan and for people without one, and puts it first after an apply', () => {
  const page = read('app/(dashboard)/home/page.tsx');
  assert.match(page, /loadRecentChanges\(supabase, \{ accountId: selectedAccount\.id, customerId: selectedAccount\.customer_id \}\)/);
  assert.match(page, /recentChanges=\{recentChangesSection\}/);
  assert.match(page, /params\.executed && recentChangesSection/);
  assert.match(page, /!params\.executed && recentChangesSection/);
  // The undo list is read before the paywall branch, so it is not behind hasProductAccess.
  assert.ok(page.indexOf('loadRecentChanges(') < page.indexOf('if (!hasProductAccess(access))'));
  assert.match(read('app/(dashboard)/home/locked-home.tsx'), /\{recentChanges\}/);
});

test('after an undo the locked home shows the same confirmation and the same errors', () => {
  assert.equal(lockedNoticeFrom({ reverted: '1' }), HOME_NOTICES.reverted);
  assert.equal(HOME_NOTICES.reverted.text, 'رجّعت التغيير مثل ما كان.');
  assert.equal(lockedNoticeFrom({ error: 'rollback_failed' })?.tone, 'bad');
  assert.equal(lockedNoticeFrom({ error: 'rollback_unavailable' })?.text, HOME_NOTICES['error:rollback_unavailable'].text);
  // Nothing else the URL carries means anything without a plan.
  assert.equal(lockedNoticeFrom({ executed: '1' }), null);
  assert.equal(lockedNoticeFrom({ subscribed: '1' }), null);
  assert.equal(lockedNoticeFrom({}), null);
  assert.equal(lockedNoticeFrom(null), null);
  // Every error the route can send back has its own line, not the generic one.
  for (const code of ['rollback_unavailable', 'rollback_failed', 'rollback_recording_failed', 'action_not_found']) {
    assert.notEqual(noticeFrom({ error: code })?.text, noticeFrom({ error: 'zzz' })?.text, code);
  }
});

test('the new copy has no long dash', () => {
  for (const notice of Object.values(HOME_NOTICES)) assert.doesNotMatch(notice.text, /[—–]/);
});
