import assert from 'node:assert/strict';
import test from 'node:test';
import { JOURNEY_STEPS, MAX_SEND_ATTEMPTS } from '../config/email-journeys';
import {
  BROADCAST_SCAN_LIMIT,
  IN_CHUNK,
  SENDING_LEASE_MS,
  chunk,
  entryLowerBound,
  findJourneyCandidateIds,
  findSegmentCandidateIds,
  loadContexts,
  loadHandledUserIds,
  toLogRow,
} from '../lib/lifecycle/context';
import { saudiWeekStart } from '../lib/lifecycle/riyadh';
import { createFakeAdmin } from './support/fake-admin';
import { ACTIVATED_AT, riyadh } from './support/lifecycle';

const NOW = riyadh('2026-10-14T12:00');
const iso = (local: string) => riyadh(local).toISOString();

const user = (id: string, stage: string | null = 'registered', extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.com`,
  name: 'سلمان',
  stage,
  messages_opt_out: false,
  email_prefs: {},
  email_suppressed_at: null,
  ...extra,
});
const padded = (prefix: string, n: number) => `${prefix}${String(n).padStart(5, '0')}`;

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

test('chunk splits into groups of at most IN_CHUNK and keeps order', () => {
  assert.equal(IN_CHUNK, 150);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  const ids = Array.from({ length: 301 }, (_, i) => i);
  assert.deepEqual(chunk(ids).map((part) => part.length), [150, 150, 1]);
});

test('toLogRow: a "sending" row older than the 10 minute lease is a dead send, treated as failed', () => {
  const base = { user_id: 'u', template: 't', attempts: 1, sent_at: null, category: 'lifecycle' };
  const fresh = toLogRow({ ...base, status: 'sending', updated_at: new Date(NOW.getTime() - SENDING_LEASE_MS + 1).toISOString() }, NOW);
  assert.equal(fresh.status, 'sending');
  const stale = toLogRow({ ...base, status: 'sending', updated_at: new Date(NOW.getTime() - SENDING_LEASE_MS).toISOString() }, NOW);
  assert.equal(stale.status, 'failed');
  assert.equal(toLogRow({ ...base, status: 'sent', updated_at: '2020-01-01T00:00:00Z' }, NOW).status, 'sent');
});

test('toLogRow: missing attempts and category become 0 and null (legacy rows)', () => {
  const row = toLogRow({ user_id: 'u', template: 'registered_1h', status: 'sent', attempts: null, sent_at: iso('2026-10-13T10:00'), updated_at: null }, NOW);
  assert.deepEqual(row, { templateKey: 'registered_1h', status: 'sent', attempts: 0, sentAt: iso('2026-10-13T10:00'), category: null });
});

// ---------------------------------------------------------------------------
// loadContexts
// ---------------------------------------------------------------------------

test('loadContexts maps users, picks the newest subscription and keeps only funnel events', async () => {
  const admin = createFakeAdmin({
    users: [
      user('a', 'analysis_viewed', { email_prefs: { lifecycle: false }, messages_opt_out: true, email_suppressed_at: '2026-10-01T00:00:00Z' }),
      user('b', 'registered', { email_prefs: 'not-an-object', messages_opt_out: null }),
      user('c', 'registered', { email_prefs: null }),
    ],
    user_events: [
      { user_id: 'a', event: 'registration_completed', created_at: iso('2026-10-10T10:00') },
      { user_id: 'a', event: 'welcome_email_sent', created_at: iso('2026-10-10T10:05') },
      { user_id: 'a', event: 'first_analysis_viewed', created_at: iso('2026-10-11T10:00') },
      { user_id: 'b', event: 'ads_account_connected', created_at: iso('2026-10-12T10:00') },
    ],
    subscriptions: [
      { user_id: 'a', status: 'canceled', created_at: iso('2026-09-01T10:00'), trial_ends_at: null, canceled_at: iso('2026-09-10T10:00'), last_event_at: null },
      { user_id: 'a', status: 'trialing', created_at: iso('2026-10-12T10:00'), trial_ends_at: iso('2026-10-26T10:00'), canceled_at: null, last_event_at: iso('2026-10-12T10:00') },
      // Same created_at: the later last_event_at wins.
      { user_id: 'b', status: 'trialing', created_at: iso('2026-10-12T10:00'), trial_ends_at: null, canceled_at: null, last_event_at: iso('2026-10-12T10:00') },
      { user_id: 'b', status: 'past_due', created_at: iso('2026-10-12T10:00'), trial_ends_at: null, canceled_at: null, last_event_at: iso('2026-10-13T10:00'), current_period_start: iso('2026-10-11T10:00') },
    ],
  });
  const contexts = await loadContexts(admin, ['a', 'b', 'c'], NOW, { relevantTemplates: [] });
  const byId = new Map(contexts.map((c) => [c.user.id, c]));

  const a = byId.get('a')!;
  assert.deepEqual(a.user, {
    id: 'a',
    email: 'a@example.com',
    name: 'سلمان',
    stage: 'analysis_viewed',
    messagesOptOut: true,
    emailPrefs: { lifecycle: false },
    emailSuppressedAt: '2026-10-01T00:00:00Z',
  });
  assert.equal(a.subscription!.status, 'trialing');
  assert.deepEqual(a.events, { registration_completed: iso('2026-10-10T10:00'), first_analysis_viewed: iso('2026-10-11T10:00') });

  const b = byId.get('b')!;
  assert.equal(b.user.messagesOptOut, false, 'only a literal true opts out');
  assert.equal(b.user.emailPrefs, null, 'a non-object preference blob is ignored');
  assert.equal(b.subscription!.status, 'past_due');
  assert.equal(b.subscription!.currentPeriodStart, iso('2026-10-11T10:00'), 'the unpaid period start is what anchors past_due');
  assert.equal(b.subscription!.lastEventAt, iso('2026-10-13T10:00'));
  assert.equal(a.subscription!.currentPeriodStart, null, 'a row without the column value maps to null');

  const c = byId.get('c')!;
  assert.equal(c.subscription, null);
  assert.deepEqual(c.events, {});
  assert.equal(c.user.emailPrefs, null);
});

test('loadContexts merges the template rows with the last 7 days of sends, once each', async () => {
  const log = (user_id: string, template: string, extra: Record<string, unknown>) => ({
    user_id,
    channel: 'email',
    template,
    status: 'sent',
    attempts: 1,
    sent_at: null,
    updated_at: iso('2026-10-01T00:00'),
    category: 'lifecycle',
    ...extra,
  });
  const admin = createFakeAdmin({
    users: [user('a')],
    message_log: [
      log('a', 'registered_1d', { sent_at: iso('2026-10-13T10:00') }), // relevant AND recent: one entry
      log('a', 'old_relevant', { sent_at: iso('2026-09-01T10:00') }), // relevant, old: kept (settles the step)
      log('a', 'other_recent', { sent_at: iso('2026-10-12T10:00'), category: null }), // not relevant, recent: kept (counts for gap and cap)
      log('a', 'other_old', { sent_at: iso('2026-09-02T10:00') }), // not relevant, old: dropped
      log('a', 'other_skipped', { status: 'skipped', sent_at: null }), // not relevant, never sent: dropped
      { ...log('a', 'sms_thing', { sent_at: iso('2026-10-13T10:00') }), channel: 'sms' }, // wrong channel
      log('a', 'stuck', { status: 'sending', sent_at: null, updated_at: iso('2026-10-14T11:00') }),
    ],
  });
  const [ctx] = await loadContexts(admin, ['a'], NOW, { relevantTemplates: ['registered_1d', 'old_relevant', 'stuck'] });
  const byTemplate = new Map(ctx!.logs.map((l) => [l.templateKey, l]));
  assert.deepEqual([...byTemplate.keys()].sort(), ['old_relevant', 'other_recent', 'registered_1d', 'stuck']);
  assert.equal(ctx!.logs.length, 4, 'no duplicates');
  assert.equal(byTemplate.get('other_recent')!.category, null);
  assert.equal(byTemplate.get('stuck')!.status, 'failed', 'the stale lease is read as a failed send');
});

test('loadContexts drops ids without a users row and duplicate ids', async () => {
  const admin = createFakeAdmin({ users: [user('a')] });
  const contexts = await loadContexts(admin, ['a', 'ghost', 'a'], NOW, { relevantTemplates: [] });
  assert.deepEqual(contexts.map((c) => c.user.id), ['a']);
  assert.deepEqual(await loadContexts(admin, [], NOW, { relevantTemplates: [] }), []);
});

test('loadContexts reads five tables per chunk of 150, however many people', async () => {
  const count = 320;
  const admin = createFakeAdmin({ users: Array.from({ length: count }, (_, i) => user(padded('u', i))) });
  const original = admin.from.bind(admin);
  let reads = 0;
  admin.from = (table: string) => {
    reads += 1;
    return original(table);
  };
  const contexts = await loadContexts(admin, Array.from({ length: count }, (_, i) => padded('u', i)), NOW, { relevantTemplates: ['registered_1d'] });
  assert.equal(contexts.length, count);
  assert.equal(reads, 3 * 5, 'three chunks (150, 150, 20) times five reads');
});

// ---------------------------------------------------------------------------
// hasWeeklyReport: the same question lib/lifecycle/facts.ts asks, for a whole chunk
// ---------------------------------------------------------------------------

/** Sunday 18 Oct 2026, 10:00 Riyadh: the week started on Saturday 17 Oct 00:00 UTC. */
const SUNDAY = riyadh('2026-10-18T10:00');
const THIS_WEEK = '2026-10-17T00:30:00Z';
const LAST_WEEK = '2026-10-10T00:30:00Z';
const weeklyRow = (accountId: string, generatedAt: string, extra: Record<string, unknown> = {}) => ({
  id: `rep-${accountId}-${generatedAt}`,
  account_id: accountId,
  period_type: 'weekly',
  generated_at: generatedAt,
  metrics: { kind: 'weekly_performance' },
  ...extra,
});
const business = (id: string, userId: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: userId,
  selected_google_ads_customer_id: null,
  created_at: '2026-09-01T00:00:00Z',
  ...extra,
});
const adsAccount = (id: string, businessId: string, customerId: string, extra: Record<string, unknown> = {}) => ({
  id,
  business_id: businessId,
  customer_id: customerId,
  status: 'active',
  is_manager: false,
  linked_at: '2026-09-02T00:00:00Z',
  ...extra,
});
const weeklyFlags = async (admin: ReturnType<typeof createFakeAdmin>, ids: string[]) => {
  const contexts = await loadContexts(admin, ids, SUNDAY, { relevantTemplates: [], weeklyReportSince: saudiWeekStart(SUNDAY) });
  return Object.fromEntries(contexts.map((c) => [c.user.id, c.hasWeeklyReport]));
};

test('hasWeeklyReport: true only with this Saudi week\'s weekly_performance report on the selected account', async () => {
  assert.equal(saudiWeekStart(SUNDAY).toISOString(), '2026-10-17T00:00:00.000Z');
  const admin = createFakeAdmin({
    users: ['has', 'old', 'none', 'nobiz', 'monthly', 'other'].map((id) => user(id)),
    businesses: ['has', 'old', 'none', 'monthly', 'other'].map((id) => business(`b-${id}`, id)),
    google_ads_accounts: ['has', 'old', 'none', 'monthly', 'other'].map((id, i) => adsAccount(`a-${id}`, `b-${id}`, `100000000${i}`)),
    reports: [
      weeklyRow('a-has', THIS_WEEK),
      weeklyRow('a-old', LAST_WEEK), // last week's numbers must not count
      weeklyRow('a-monthly', THIS_WEEK, { period_type: 'monthly' }),
      weeklyRow('a-other', THIS_WEEK, { metrics: { kind: 'something_else' } }),
      weeklyRow('a-nobody', THIS_WEEK), // an account nobody in the chunk owns
    ],
  });
  assert.deepEqual(await weeklyFlags(admin, ['has', 'old', 'none', 'nobiz', 'monthly', 'other']), {
    has: true,
    old: false,
    none: false,
    nobiz: false,
    monthly: false,
    other: false,
  });
});

test('hasWeeklyReport: the account is chosen the way the fact loader chooses it (persisted selection, newest business, no managers)', async () => {
  const admin = createFakeAdmin({
    users: ['sel', 'twin', 'mgr', 'revoked'].map((id) => user(id)),
    businesses: [
      business('b-sel', 'sel', { selected_google_ads_customer_id: '2222222222' }),
      // twin: an older business with a report and a newer one without; the newest business wins.
      business('b-twin-old', 'twin', { created_at: '2026-08-01T00:00:00Z' }),
      business('b-twin-new', 'twin', { created_at: '2026-09-15T00:00:00Z' }),
      business('b-mgr', 'mgr'),
      business('b-revoked', 'revoked'),
    ],
    google_ads_accounts: [
      adsAccount('a-sel-1', 'b-sel', '1111111111', { linked_at: '2026-09-05T00:00:00Z' }), // newest linked, not selected
      adsAccount('a-sel-2', 'b-sel', '2222222222', { linked_at: '2026-09-02T00:00:00Z' }), // the persisted selection
      adsAccount('a-twin-old', 'b-twin-old', '3333333333'),
      adsAccount('a-twin-new', 'b-twin-new', '4444444444'),
      adsAccount('a-mgr-manager', 'b-mgr', '5555555555', { is_manager: true, linked_at: '2026-09-09T00:00:00Z' }),
      adsAccount('a-mgr-client', 'b-mgr', '6666666666'),
      adsAccount('a-revoked', 'b-revoked', '7777777777', { status: 'revoked' }),
    ],
    reports: [
      weeklyRow('a-sel-1', THIS_WEEK), // the report is on the account that is NOT selected
      weeklyRow('a-twin-old', THIS_WEEK),
      weeklyRow('a-mgr-manager', THIS_WEEK),
      weeklyRow('a-revoked', THIS_WEEK),
    ],
  });
  assert.deepEqual(await weeklyFlags(admin, ['sel', 'twin', 'mgr', 'revoked']), {
    sel: false, // a-sel-2 is selected and has no report
    twin: false, // b-twin-new has no report
    mgr: false, // the manager account is never the account
    revoked: false, // only active accounts are selectable: a revoked-only business has none
  });

  admin.tables.reports!.push(weeklyRow('a-sel-2', THIS_WEEK), weeklyRow('a-twin-new', THIS_WEEK), weeklyRow('a-mgr-client', THIS_WEEK));
  assert.deepEqual(await weeklyFlags(admin, ['sel', 'twin', 'mgr', 'revoked']), { sel: true, twin: true, mgr: true, revoked: false });
});

test('hasWeeklyReport: three extra reads per chunk while a slot is open, none without weeklyReportSince (and then it is false)', async () => {
  const count = 320;
  const ids = Array.from({ length: count }, (_, i) => padded('u', i));
  const admin = createFakeAdmin({
    users: ids.map((id) => user(id)),
    businesses: ids.map((id) => business(`b-${id}`, id)),
    google_ads_accounts: ids.map((id, i) => adsAccount(`a-${id}`, `b-${id}`, String(1000000000 + i))),
    reports: ids.map((id) => weeklyRow(`a-${id}`, THIS_WEEK)),
  });
  const original = admin.from.bind(admin);
  const tables: string[] = [];
  admin.from = (table: string) => {
    tables.push(table);
    return original(table);
  };

  const without = await loadContexts(admin, ids, SUNDAY, { relevantTemplates: [] });
  assert.equal(tables.length, 3 * 5);
  assert.ok(without.every((c) => c.hasWeeklyReport === false));

  tables.length = 0;
  const withFlag = await loadContexts(admin, ids, SUNDAY, { relevantTemplates: [], weeklyReportSince: saudiWeekStart(SUNDAY) });
  assert.equal(tables.length, 3 * 5 + 3 * 3, 'five reads plus businesses, accounts and reports, per chunk');
  assert.equal(withFlag.filter((c) => c.hasWeeklyReport).length, count);
});

test('hasWeeklyReport: a failed read is a clear exception, never a silent "no report"', async () => {
  const admin = createFakeAdmin({
    users: [user('a')],
    businesses: [business('b-a', 'a')],
    google_ads_accounts: [adsAccount('a-a', 'b-a', '1111111111')],
  });
  const original = admin.from.bind(admin);
  admin.from = (table: string) => {
    const query = original(table);
    if (table === 'reports') {
      const then = query.then.bind(query);
      query.then = ((resolve: any, reject: any) => then(() => resolve({ data: null, error: { code: '57014' } }), reject)) as typeof query.then;
    }
    return query;
  };
  await assert.rejects(weeklyFlags(admin, ['a']), /could not load reports \(57014\)/);
});

test('loadContexts pages past the 1000 row response cap', async () => {
  // 150 people with 9 events each: 1350 event rows in one chunk.
  const ids = Array.from({ length: 150 }, (_, i) => padded('u', i));
  const events = ids.flatMap((id) =>
    Array.from({ length: 9 }, (_, i) => ({ user_id: id, event: i === 0 ? 'registration_completed' : 'ads_account_connected', created_at: iso(`2026-10-1${i}T10:00`) }))
  );
  const admin = createFakeAdmin({ users: ids.map((id) => user(id)), user_events: events });
  const contexts = await loadContexts(admin, ids, NOW, { relevantTemplates: [] });
  assert.equal(contexts.length, 150);
  assert.ok(contexts.every((c) => c.events.registration_completed === iso('2026-10-10T10:00')), 'no person lost their events at the page boundary');
});

test('loadContexts turns a database error into a clear exception, never a silent empty list', async () => {
  const admin = createFakeAdmin({ users: [user('a')] });
  const original = admin.from.bind(admin);
  admin.from = (table: string) => {
    const query = original(table);
    if (table === 'users') {
      const then = query.then.bind(query);
      query.then = ((resolve: any, reject: any) => then(() => resolve({ data: null, error: { code: '42703' } }), reject)) as typeof query.then;
    }
    return query;
  };
  await assert.rejects(loadContexts(admin, ['a'], NOW, { relevantTemplates: [] }), /could not load users \(42703\)/);
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test('entryLowerBound: the later of "step expiry horizon" and "activation minus the last step"', () => {
  const activatedAt = iso('2026-10-01T00:00');
  const registered = entryLowerBound({ steps: JOURNEY_STEPS, journey: 'registered', now: NOW, activatedAt });
  // horizon: 7 days + 48 h = 9 days back from now beats activation minus 7 days.
  assert.equal(new Date(registered).toISOString(), new Date(NOW.getTime() - 9 * 86_400_000).toISOString());

  const early = entryLowerBound({ steps: JOURNEY_STEPS, journey: 'registered', now: riyadh('2026-10-02T12:00'), activatedAt });
  assert.equal(new Date(early).toISOString(), new Date(Date.parse(activatedAt) - 7 * 86_400_000).toISOString(), 'right after activation the activation bound is the later one');

  const canceled = entryLowerBound({ steps: JOURNEY_STEPS, journey: 'canceled', now: NOW, activatedAt });
  assert.equal(new Date(canceled).toISOString(), new Date(NOW.getTime() - (30 + 7) * 86_400_000).toISOString());
});

test('journey candidates: only people who could still have a step due', async () => {
  const sub = (userId: string, status: string, extra: Record<string, unknown> = {}) => ({
    user_id: userId,
    status,
    created_at: iso('2026-09-01T10:00'),
    trial_ends_at: null,
    canceled_at: null,
    last_event_at: null,
    ...extra,
  });
  const admin = createFakeAdmin({
    user_events: [
      { user_id: 'reg_new', event: 'registration_completed', created_at: iso('2026-10-12T10:00') },
      { user_id: 'reg_old', event: 'registration_completed', created_at: iso('2026-10-01T10:00') }, // past the 9 day horizon
      { user_id: 'con_new', event: 'ads_account_connected', created_at: iso('2026-10-13T10:00') },
      { user_id: 'con_old', event: 'ads_account_connected', created_at: iso('2026-10-05T10:00') },
      { user_id: 'plan_new', event: 'first_analysis_viewed', created_at: iso('2026-10-10T10:00') },
      { user_id: 'plan_old', event: 'first_analysis_viewed', created_at: iso('2026-09-20T10:00') },
    ],
    subscriptions: [
      sub('trial_new', 'trialing', { created_at: iso('2026-10-10T10:00') }),
      sub('trial_old', 'trialing', { created_at: iso('2026-09-01T10:00') }),
      sub('past_due_any', 'past_due'),
      sub('canceled_new', 'canceled', { canceled_at: iso('2026-10-10T10:00') }),
      sub('canceled_old', 'canceled', { canceled_at: iso('2026-08-01T10:00') }),
      sub('canceled_no_date', 'canceled', { trial_ends_at: iso('2026-10-10T10:00') }),
      sub('active_one', 'active'),
    ],
  });
  const config = { steps: JOURNEY_STEPS, maxAttempts: MAX_SEND_ATTEMPTS };
  const ids = async (weeklyKey: string | null) => (await findJourneyCandidateIds(admin, { now: NOW, activatedAt: ACTIVATED_AT, config, weeklyKey })).sort();

  assert.deepEqual(await ids(null), ['canceled_new', 'canceled_no_date', 'con_new', 'past_due_any', 'plan_new', 'reg_new', 'trial_new']);

  // With a weekly slot open, every trialing/active subscriber without this week's key joins.
  assert.deepEqual(await ids('weekly_report_2026-W42'), [
    'active_one',
    'canceled_new',
    'canceled_no_date',
    'con_new',
    'past_due_any',
    'plan_new',
    'reg_new',
    'trial_new',
    'trial_old',
  ]);
});

test('journey candidates: a cancel requested long ago that ended recently is still found (the anchor is the event time)', async () => {
  const sub = (userId: string, extra: Record<string, unknown>) => ({
    user_id: userId,
    status: 'canceled',
    created_at: iso('2025-10-01T10:00'),
    trial_ends_at: null,
    canceled_at: null,
    last_event_at: null,
    ...extra,
  });
  const admin = createFakeAdmin({
    subscriptions: [
      // A yearly plan: the customer asked to cancel in February and it ended three days ago.
      sub('yearly_ended_now', { canceled_at: iso('2026-02-10T10:00'), last_event_at: iso('2026-10-11T10:00') }),
      sub('ended_long_ago', { canceled_at: iso('2026-02-10T10:00'), last_event_at: iso('2026-03-01T10:00') }),
    ],
  });
  const config = { steps: JOURNEY_STEPS, maxAttempts: MAX_SEND_ATTEMPTS };
  const found = await findJourneyCandidateIds(admin, { now: NOW, activatedAt: ACTIVATED_AT, config, weeklyKey: null });
  assert.deepEqual(found.sort(), ['yearly_ended_now']);
});

test('journey candidates: people who already have this week\'s report are not loaded again', async () => {
  const admin = createFakeAdmin({
    subscriptions: ['a', 'b', 'c'].map((id) => ({ user_id: id, status: 'active', created_at: iso('2026-09-01T10:00'), trial_ends_at: null, canceled_at: null, last_event_at: null })),
    message_log: [
      { user_id: 'a', channel: 'email', template: 'weekly_report_2026-W42', status: 'sent', attempts: 1, sent_at: iso('2026-10-18T09:05'), updated_at: iso('2026-10-18T09:05') },
      { user_id: 'b', channel: 'email', template: 'weekly_report_2026-W42', status: 'skipped', attempts: 0, sent_at: null, updated_at: iso('2026-10-18T09:05') },
      { user_id: 'c', channel: 'email', template: 'weekly_report_2026-W41', status: 'sent', attempts: 1, sent_at: iso('2026-10-11T09:05'), updated_at: iso('2026-10-11T09:05') },
    ],
  });
  const ids = await findJourneyCandidateIds(admin, {
    now: riyadh('2026-10-18T10:00'),
    activatedAt: ACTIVATED_AT,
    config: { steps: JOURNEY_STEPS, maxAttempts: MAX_SEND_ATTEMPTS },
    weeklyKey: 'weekly_report_2026-W42',
  });
  assert.deepEqual(ids, ['c']);
});

test('journey candidates: more than 1000 matching rows are all returned', async () => {
  const events = Array.from({ length: 2300 }, (_, i) => ({ user_id: padded('u', i), event: 'registration_completed', created_at: iso('2026-10-13T10:00') }));
  const admin = createFakeAdmin({ user_events: events });
  const ids = await findJourneyCandidateIds(admin, {
    now: NOW,
    activatedAt: ACTIVATED_AT,
    config: { steps: JOURNEY_STEPS, maxAttempts: MAX_SEND_ATTEMPTS },
    weeklyKey: null,
  });
  assert.equal(ids.length, 2300);
  assert.equal(new Set(ids).size, 2300);
});

test('handled ids: sent, skipped, in flight and out-of-attempts failures are done; retryable failures and dead leases are not', async () => {
  const row = (user_id: string, status: string, extra: Record<string, unknown> = {}) => ({
    user_id,
    channel: 'email',
    template: 'broadcast_x',
    status,
    attempts: 1,
    sent_at: null,
    updated_at: iso('2026-10-14T11:55'),
    ...extra,
  });
  const admin = createFakeAdmin({
    message_log: [
      row('sent', 'sent'),
      row('skipped', 'skipped', { attempts: 0 }),
      row('flight', 'sending'),
      row('dead_lease', 'sending', { updated_at: iso('2026-10-14T10:00') }),
      row('failed_once', 'failed'),
      row('failed_out', 'failed', { attempts: MAX_SEND_ATTEMPTS }),
      { ...row('other_template', 'sent'), template: 'broadcast_y' },
      { ...row('other_channel', 'sent'), channel: 'sms' },
    ],
  });
  const handled = await loadHandledUserIds(admin, 'broadcast_x', NOW, MAX_SEND_ATTEMPTS);
  assert.deepEqual([...handled].sort(), ['failed_out', 'flight', 'sent', 'skipped']);
});

// ---------------------------------------------------------------------------
// Segment candidates
// ---------------------------------------------------------------------------

test('segment candidates by stage: stable order, exclusions applied, limit respected', async () => {
  const admin = createFakeAdmin({
    users: [user('d'), user('b'), user('a'), user('c', 'connected'), user('e'), user('f', null)],
  });
  const ids = (segment: Parameters<typeof findSegmentCandidateIds>[1], exclude: string[] = [], limit = 10) =>
    findSegmentCandidateIds(admin, segment, { exclude: new Set(exclude), limit });

  assert.deepEqual(await ids('registered_not_connected'), ['a', 'b', 'd', 'e']);
  assert.deepEqual(await ids('registered_not_connected', ['b', 'e']), ['a', 'd']);
  assert.deepEqual(await ids('registered_not_connected', [], 2), ['a', 'b']);
  assert.deepEqual(await ids('connected_no_trial'), ['c']);
  assert.deepEqual(await ids('all'), ['a', 'b', 'c', 'd', 'e'], 'unfinished registrations (null stage) are not in any segment');
});

test('segment candidates by subscription status', async () => {
  const sub = (userId: string, status: string) => ({ user_id: userId, status, created_at: iso('2026-09-01T10:00') });
  const admin = createFakeAdmin({
    subscriptions: [sub('t', 'trialing'), sub('a', 'active'), sub('c1', 'canceled'), sub('c2', 'canceled'), sub('p', 'past_due'), sub('a', 'active')],
  });
  const ids = (segment: Parameters<typeof findSegmentCandidateIds>[1]) => findSegmentCandidateIds(admin, segment, { exclude: new Set(), limit: 10 });
  assert.deepEqual(await ids('subscribers'), ['a', 't']);
  assert.deepEqual(await ids('canceled'), ['c1', 'c2']);
  assert.deepEqual(await ids('trial_lapsed'), ['c1', 'c2']);
});

test('segment candidates keep paging past excluded people instead of stopping at the first page', async () => {
  const total = 1300;
  const admin = createFakeAdmin({ users: Array.from({ length: total }, (_, i) => user(padded('u', i))) });
  const exclude = new Set(Array.from({ length: 1100 }, (_, i) => padded('u', i)));
  const ids = await findSegmentCandidateIds(admin, 'registered_not_connected', { exclude, limit: 5 });
  assert.deepEqual(ids, [1100, 1101, 1102, 1103, 1104].map((i) => padded('u', i)));
  assert.ok(BROADCAST_SCAN_LIMIT >= 5);
});
