import assert from 'node:assert/strict';
import test from 'node:test';
import type { Broadcast } from '../config/email-broadcasts';
import { broadcastGate, broadcastTemplateKey, inSegment, planBroadcast } from '../lib/lifecycle/broadcast';
import type { PlanContext } from '../lib/lifecycle/plan';
import { ACTIVATED_AT, approvedCopy, makeCtx, riyadh, sentLog } from './support/lifecycle';

const copy = approvedCopy();
const NOW = riyadh('2026-10-14T12:00');

const broadcast = (overrides: Partial<Broadcast> = {}): Broadcast => ({
  id: 'chat_relaunch',
  copyKey: 'broadcast_chat_relaunch',
  segment: 'registered_not_connected',
  notBefore: null,
  approved: true,
  ...overrides,
});

const user = (id: string, extra: Parameters<typeof makeCtx>[0] = {}) =>
  makeCtx({ ...extra, user: { id, email: `${id}@example.com`, stage: 'registered', ...extra.user } });

const run = (
  contexts: PlanContext[],
  overrides: Partial<Parameters<typeof planBroadcast>[0]> = {}
) => planBroadcast({ now: NOW, broadcast: broadcast(), contexts, copy, config: { activatedAt: ACTIVATED_AT }, limit: 40, ...overrides });

const ids = (result: ReturnType<typeof run>) => result.sends.map((s) => s.userId);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('broadcast template key is broadcast_<id>', () => {
  assert.equal(broadcastTemplateKey({ id: 'chat_relaunch' }), 'broadcast_chat_relaunch');
});

test('gate: ready only with a global activation moment, both approvals and notBefore passed', () => {
  const gate = (overrides: Partial<Parameters<typeof broadcastGate>[0]> = {}) =>
    broadcastGate({ broadcast: broadcast(), now: NOW, activatedAt: ACTIVATED_AT, copy, ...overrides });

  assert.equal(gate(), 'ready');
  assert.equal(gate({ activatedAt: null }), 'not_activated');
  assert.equal(gate({ activatedAt: 'garbage' }), 'not_activated');
  assert.equal(gate({ broadcast: broadcast({ approved: false }) }), 'not_approved');
  assert.equal(gate({ copy: { ...copy, broadcast_chat_relaunch: { ...copy.broadcast_chat_relaunch, approved: false } } }), 'copy_not_approved');
  assert.equal(gate({ broadcast: broadcast({ notBefore: '2026-10-14T13:00:00+03:00' }) }), 'not_yet');
  assert.equal(gate({ broadcast: broadcast({ notBefore: '2026-10-14T12:00:00+03:00' }) }), 'ready', 'notBefore is inclusive');
  assert.equal(gate({ broadcast: broadcast({ notBefore: 'garbage' }) }), 'not_yet', 'an unreadable notBefore blocks, it never opens');
});

test('gate: the shipped broadcast is closed in every way', () => {
  assert.equal(broadcastGate({ broadcast: { ...broadcast(), approved: false }, now: NOW, activatedAt: null }), 'not_activated');
  assert.equal(broadcastGate({ broadcast: broadcast({ approved: false }), now: NOW, activatedAt: ACTIVATED_AT }), 'not_approved');
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

test('segments: who belongs where', () => {
  const sub = (status: string, extra: Record<string, string | null> = {}) => ({ status, createdAt: '2026-10-01T10:00:00Z', ...extra });
  const registeredUser = user('r');
  const connected = user('c', { user: { stage: 'connected' } });
  const viewed = user('v', { user: { stage: 'analysis_viewed' } });
  const unfinished = user('n', { user: { stage: null } });
  const trial = user('t', { user: { stage: 'analysis_viewed' }, subscription: sub('trialing') });
  const lapsed = user('l', { user: { stage: 'analysis_viewed' }, subscription: sub('canceled', { canceledAt: '2026-10-05T10:00:00Z' }) });
  const canceled = user('x', {
    user: { stage: 'subscribed' },
    subscription: sub('canceled', { canceledAt: '2026-10-05T10:00:00Z' }),
    events: { subscription_paid: '2026-10-02T10:00:00Z' },
  });
  const active = user('a', { user: { stage: 'subscribed' }, subscription: sub('active'), events: { subscription_paid: '2026-10-02T10:00:00Z' } });
  const pastDue = user('p', { user: { stage: 'subscribed' }, subscription: sub('past_due'), events: { subscription_paid: '2026-10-02T10:00:00Z' } });

  const who = (segment: Parameters<typeof inSegment>[0]) =>
    [registeredUser, connected, viewed, unfinished, trial, lapsed, canceled, active, pastDue].filter((c) => inSegment(segment, c)).map((c) => c.user.id);

  assert.deepEqual(who('registered_not_connected'), ['r']);
  assert.deepEqual(who('connected_no_trial'), ['c', 'v']);
  assert.deepEqual(who('trial_lapsed'), ['l']);
  assert.deepEqual(who('canceled'), ['x']);
  assert.deepEqual(who('subscribers'), ['t', 'a']);
  assert.deepEqual(who('all'), ['r', 'c', 'v', 't', 'l', 'x', 'a', 'p'], 'everyone who finished registration');
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test('a segment member is planned with the broadcast template key and its copy category', () => {
  const result = run([user('a')]);
  assert.equal(result.sends.length, 1);
  const [send] = result.sends;
  assert.equal(send!.kind, 'broadcast');
  assert.equal(send!.templateKey, 'broadcast_chat_relaunch');
  assert.equal(send!.copyKey, 'broadcast_chat_relaunch');
  assert.equal(send!.category, 'product_news');
  assert.equal(send!.journey, null);
  assert.equal(send!.dueAt, NOW.toISOString());
});

test('people outside the segment are ignored', () => {
  const result = run([user('a'), user('b', { user: { stage: 'connected' } })]);
  assert.deepEqual(ids(result), ['a']);
  assert.equal(result.ignored.not_in_segment, 1);
});

test('the batch limit caps the sends and the order is stable by user id', () => {
  const contexts = ['d', 'b', 'e', 'a', 'c'].map((id) => user(id));
  assert.deepEqual(ids(run(contexts, { limit: 3 })), ['a', 'b', 'c']);
  assert.deepEqual(ids(run(contexts, { limit: 0 })), []);
  assert.deepEqual(ids(run(contexts, { limit: 40 })), ['a', 'b', 'c', 'd', 'e']);
});

test('each person is mailed at most once: sent, skipped and in-flight rows settle the broadcast', () => {
  const row = (status: 'sent' | 'skipped' | 'sending') => ({ templateKey: 'broadcast_chat_relaunch', status, attempts: 1, sentAt: null, category: null });
  const result = run([
    user('a', { logs: [row('sent')] }),
    user('b', { logs: [row('skipped')] }),
    user('c', { logs: [row('sending')] }),
    user('d'),
  ]);
  assert.deepEqual(ids(result), ['d']);
  assert.equal(result.ignored.already_handled, 3);
});

test('a failed broadcast row is retried until its attempts are used', () => {
  const failed = (attempts: number) => [{ templateKey: 'broadcast_chat_relaunch', status: 'failed' as const, attempts, sentAt: null, category: null }];
  assert.deepEqual(ids(run([user('a', { logs: failed(2) })])), ['a']);
  assert.deepEqual(ids(run([user('a', { logs: failed(3) })])), []);
});

test('people already planned in this run are left for a later run', () => {
  const result = run([user('a'), user('b')], { excludeUserIds: new Set(['a']) });
  assert.deepEqual(ids(result), ['b']);
  assert.equal(result.ignored.already_planned, 1);
});

test('a broadcast ignores the activation moment and the holdout group', () => {
  const result = run([user('a'), user('b')], { config: { activatedAt: null, isHeldOut: () => true } });
  assert.deepEqual(ids(result), ['a', 'b']);
  // Registered long before activation: still mailed.
  const early = run([user('a', { events: { registration_completed: '2020-01-01T00:00:00Z' } })], { config: { activatedAt: riyadh('2026-10-14T00:00').toISOString() } });
  assert.deepEqual(ids(early), ['a']);
});

test('permanent blockers become skips so the next run does not scan them again', () => {
  const result = run([
    user('a', { user: { emailSuppressedAt: '2026-10-01T00:00:00Z' } }),
    user('b', { user: { email: null } }),
    user('c', { user: { messagesOptOut: true } }),
    user('d', { user: { emailPrefs: { product_news: false } } }),
    user('e'),
  ]);
  assert.deepEqual(ids(result), ['e']);
  assert.deepEqual(
    result.skips.map((s) => `${s.userId}:${s.reason}`),
    ['a:suppressed', 'b:no_email', 'c:opted_out', 'd:category_off']
  );
  for (const skip of result.skips) {
    assert.equal(skip.templateKey, 'broadcast_chat_relaunch');
    assert.equal(skip.category, 'product_news');
  }
});

test('only the product_news preference matters to a product_news broadcast', () => {
  const result = run([
    user('a', { user: { emailPrefs: { lifecycle: false, weekly_report: false } } }),
    user('b', { user: { emailPrefs: { product_news: true } } }),
  ]);
  assert.deepEqual(ids(result), ['a', 'b']);
});

test('transient blockers (gap, cap, window) are left alone: no skip row, retried next run', () => {
  const gap = user('a', { logs: [sentLog('registered_1d', riyadh('2026-10-14T00:00'))] });
  const cap = user('b', {
    logs: [sentLog('x1', riyadh('2026-10-08T12:00')), sentLog('x2', riyadh('2026-10-10T12:00')), sentLog('x3', riyadh('2026-10-12T12:00'))],
  });
  const free = user('c');
  const result = run([gap, cap, free]);
  assert.deepEqual(ids(result), ['c']);
  assert.equal(result.ignored.min_gap, 1);
  assert.equal(result.ignored.max_per_7_days, 1);
  assert.deepEqual(result.skips, []);

  const night = run([user('a'), user('b')], { now: riyadh('2026-10-14T22:00') });
  assert.deepEqual(night.sends, []);
  assert.equal(night.ignored.outside_window, 2);
  assert.deepEqual(night.skips, []);
});

test('transactional mail does not delay a broadcast', () => {
  const ctx = user('a', { logs: [sentLog('tx_trial_ending', riyadh('2026-10-14T11:00'), 'transactional')] });
  assert.deepEqual(ids(run([ctx])), ['a']);
});

test('a user blocked by the guard does not use up the batch', () => {
  const blocked = Array.from({ length: 5 }, (_, i) => user(`a${i}`, { logs: [sentLog('x', riyadh('2026-10-14T10:00'))] }));
  const free = ['z1', 'z2'].map((id) => user(id));
  assert.deepEqual(ids(run([...blocked, ...free], { limit: 2 })), ['z1', 'z2']);
});
