import assert from 'node:assert/strict';
import test from 'node:test';
import type { Broadcast } from '../config/email-broadcasts';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { runEmailLifecycle, type LoadEmailFactsFn, type SendTemplateFn, type SendTemplateInput } from '../lib/lifecycle/run';
import { EMPTY_FACTS, type EmailCopy } from '../lib/lifecycle/types';
import { createFakeAdmin } from './support/fake-admin';
import { ACTIVATED_AT, adsAccountSeed, approvedCopy, fakeSendTemplate, richFacts, riyadh, weeklyReportRow } from './support/lifecycle';

/** Wednesday 14 Oct 2026, noon in Riyadh: inside the window, no weekly slot open. */
const NOW = riyadh('2026-10-14T12:00');
const SUNDAY = riyadh('2026-10-18T10:00');

type Admin = ReturnType<typeof createFakeAdmin>;
type Seed = {
  users?: Array<Record<string, unknown>>;
  user_events?: Array<Record<string, unknown>>;
  subscriptions?: Array<Record<string, unknown>>;
  message_log?: Array<Record<string, unknown>>;
  businesses?: Array<Record<string, unknown>>;
  google_ads_accounts?: Array<Record<string, unknown>>;
  reports?: Array<Record<string, unknown>>;
};

const user = (id: string, stage: string | null = 'registered', extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.com`,
  name: 'سلمان العتيبي',
  stage,
  messages_opt_out: false,
  email_prefs: {},
  email_suppressed_at: null,
  ...extra,
});
const event = (userId: string, name: string, at: string) => ({ user_id: userId, event: name, created_at: riyadh(at).toISOString() });
const subscription = (userId: string, status: string, extra: Record<string, unknown> = {}) => ({
  user_id: userId,
  status,
  created_at: riyadh('2026-09-01T10:00').toISOString(),
  trial_ends_at: null,
  canceled_at: null,
  last_event_at: null,
  ...extra,
});

/** Registered 13 Oct 10:00: registered_1d is due, nothing else. */
const dueRegistered = (id: string) => ({ users: [user(id)], user_events: [event(id, 'registration_completed', '2026-10-13T10:00')] });
/** Both connect steps are overdue at NOW: connected_1d goes, connected_3h is superseded. */
const connectedBoth = (id: string) => ({
  users: [user(id, 'connected')],
  user_events: [event(id, 'registration_completed', '2026-10-12T10:00'), event(id, 'ads_account_connected', '2026-10-13T08:00')],
});

function merge(...parts: Seed[]): Seed {
  return {
    users: parts.flatMap((p) => p.users ?? []),
    user_events: parts.flatMap((p) => p.user_events ?? []),
    subscriptions: parts.flatMap((p) => p.subscriptions ?? []),
    message_log: parts.flatMap((p) => p.message_log ?? []),
    businesses: parts.flatMap((p) => p.businesses ?? []),
    google_ads_accounts: parts.flatMap((p) => p.google_ads_accounts ?? []),
    reports: parts.flatMap((p) => p.reports ?? []),
  };
}

/** Saturday 00:30 UTC before SUNDAY: when the optimize cron writes the week's report (the week starts 00:00 UTC). */
const REPORT_W42 = new Date('2026-10-17T00:30:00Z');
/** These users have an account and this week's (W42) weekly report is already stored. */
const withReports = (...ids: string[]): Seed => ({ ...adsAccountSeed(ids), reports: ids.map((id) => weeklyReportRow(id, REPORT_W42)) });
/** The facts loader as it behaves for a user whose weekly report does not exist: everything but the weekly fact. */
const noWeeklyFact: LoadEmailFactsFn = async (a, u) => ({ ...(await richFacts(a, u)), weekly: null });

type GoOptions = {
  now?: Date;
  dryRun?: boolean;
  config?: NonNullable<Parameters<typeof runEmailLifecycle>[0]['config']>;
  sendTemplate?: SendTemplateFn;
  facts?: LoadEmailFactsFn;
  clock?: () => number;
  sendTemplateDeps?: object;
};

async function go(admin: Admin, options: GoOptions = {}) {
  const now = options.now ?? NOW;
  admin.setClock(() => now);
  const fake = fakeSendTemplate(admin);
  const factCalls: Array<{ id: string; needs: string[] }> = [];
  const facts: LoadEmailFactsFn =
    options.facts ??
    (async (a, u, needs) => {
      factCalls.push({ id: u.id, needs: [...needs] });
      return richFacts(a, u);
    });
  const summary = await runEmailLifecycle({
    admin,
    now,
    dryRun: options.dryRun,
    config: { activatedAt: ACTIVATED_AT, copy: approvedCopy(), broadcasts: [], plan: { isHeldOut: () => false }, ...options.config },
    deps: { sendTemplate: options.sendTemplate ?? fake.fn, loadEmailFacts: facts, clock: options.clock, sendTemplateDeps: options.sendTemplateDeps },
  });
  return { summary, calls: fake.calls, factCalls };
}

function spyOnTables(admin: Admin): string[] {
  const touched: string[] = [];
  const original = admin.from.bind(admin);
  admin.from = (table: string) => {
    touched.push(table);
    return original(table);
  };
  return touched;
}

/** Runs `mutate` once, right before the runner writes its first skipped rows (after planning, before sending). */
function beforeSkipWrite(admin: Admin, mutate: () => void) {
  const original = admin.from.bind(admin);
  let done = false;
  admin.from = (table: string) => {
    const query = original(table);
    if (table === 'message_log' && !done) {
      const upsert = query.upsert.bind(query);
      query.upsert = (...args: Parameters<typeof upsert>) => {
        if (!done) {
          done = true;
          mutate();
        }
        return upsert(...args);
      };
    }
    return query;
  };
}

const logRow = (admin: Admin, userId: string, template: string) =>
  admin.tables.message_log!.find((r) => r.user_id === userId && r.template === template);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('without an activation moment the run does nothing and does not even read the database', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a')));
  const touched = spyOnTables(admin);
  const { summary, calls } = await go(admin, { config: { activatedAt: null } });
  assert.equal(summary.gate, 'not_activated');
  assert.equal(summary.ignored.not_activated, 1);
  assert.equal(summary.sent, 0);
  assert.deepEqual(touched, []);
  assert.deepEqual(calls, []);
  assert.equal(admin.tables.message_log!.length, 0);
});

test('an unreadable activation moment is treated as not activated', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a')));
  const { summary } = await go(admin, { config: { activatedAt: 'whenever' } });
  assert.equal(summary.gate, 'not_activated');
  assert.equal(admin.tables.message_log!.length, 0);
});

test('the shipped state (null activation, unapproved copy) sends nothing even on a real run', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a')));
  admin.setClock(() => NOW);
  const fake = fakeSendTemplate(admin);
  const summary = await runEmailLifecycle({ admin, now: NOW, deps: { sendTemplate: fake.fn, loadEmailFacts: richFacts } });
  assert.equal(summary.gate, 'not_activated');
  assert.equal(fake.calls.length, 0);
});

test('with an activation moment but unapproved copy, nothing is sent and nothing is written', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), connectedBoth('c')));
  const { summary, calls } = await go(admin, { config: { copy: EMAIL_COPY } });
  assert.equal(summary.gate, 'open');
  assert.equal(summary.sent, 0);
  assert.equal(summary.ignored.not_approved, 2);
  assert.deepEqual(calls, []);
  assert.equal(admin.tables.message_log!.length, 0, 'unapproved copy is ignored, never logged');
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('dry run: reports the plan and writes, sends and loads nothing', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), connectedBoth('c')));
  const before = JSON.stringify(admin.tables);
  const { summary, calls, factCalls } = await go(admin, { dryRun: true });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.planned.total, 2);
  assert.deepEqual(summary.planned.byTemplate, { connected_1d: 1, registered_1d: 1 });
  assert.deepEqual(summary.planned.byKind, { journey: 2, weekly: 0, broadcast: 0 });
  assert.deepEqual(summary.skips, { superseded: 1, expired: 0, permanent: 0, recorded: 0 });
  assert.deepEqual(summary.sample.map((s) => `${s.userId}:${s.templateKey}`), ['c:connected_1d', 'a:registered_1d']);
  assert.equal(summary.sent, 0);
  assert.deepEqual(summary.results, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(factCalls, []);
  assert.equal(JSON.stringify(admin.tables), before, 'not one row changed');
});

test('dry run with assumeApproved previews unapproved copy; a real run ignores the flag', async () => {
  const seed = merge(dueRegistered('a'));
  const dry = await go(createFakeAdmin(seed), { dryRun: true, config: { copy: EMAIL_COPY, assumeApproved: true } });
  assert.equal(dry.summary.planned.total, 1);

  const plain = await go(createFakeAdmin(seed), { dryRun: true, config: { copy: EMAIL_COPY } });
  assert.equal(plain.summary.planned.total, 0);
  assert.equal(plain.summary.ignored.not_approved, 1);

  const real = await go(createFakeAdmin(seed), { config: { copy: EMAIL_COPY, assumeApproved: true } });
  assert.equal(real.summary.planned.total, 0, 'assumeApproved never applies to a real run');
  assert.deepEqual(real.calls, []);
});

test('dry run with assumeApproved also opens an unapproved broadcast for the preview', async () => {
  const broadcast: Broadcast = { id: 'chat_relaunch', copyKey: 'broadcast_chat_relaunch', segment: 'registered_not_connected', notBefore: null, approved: false };
  const admin = createFakeAdmin({ users: [user('a'), user('b')] });
  const closed = await go(admin, { dryRun: true, config: { broadcasts: [broadcast] } });
  assert.deepEqual(closed.summary.broadcasts, [{ id: 'chat_relaunch', gate: 'not_approved', planned: 0 }]);
  const open = await go(admin, { dryRun: true, config: { broadcasts: [broadcast], assumeApproved: true } });
  assert.deepEqual(open.summary.broadcasts, [{ id: 'chat_relaunch', gate: 'ready', planned: 2 }]);
});

// ---------------------------------------------------------------------------
// A real run
// ---------------------------------------------------------------------------

test('a real run sends what is planned and records the steps that will never go out', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), connectedBoth('c')));
  const { summary, calls, factCalls } = await go(admin);

  assert.equal(summary.sent, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.results.map((r) => `${r.userId}:${r.templateKey}:${r.result}`), ['c:connected_1d:sent', 'a:registered_1d:sent']);
  assert.deepEqual(calls.map((c) => c.templateKey), ['connected_1d', 'registered_1d']);
  assert.deepEqual(factCalls, [{ id: 'c', needs: [] }, { id: 'a', needs: [] }]);

  assert.equal(logRow(admin, 'c', 'connected_1d')!.status, 'sent');
  assert.equal(logRow(admin, 'a', 'registered_1d')!.status, 'sent');
  const skipped = logRow(admin, 'c', 'connected_3h')!;
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'superseded');
  assert.equal(skipped.category, 'lifecycle');
  assert.equal(skipped.copy_key, 'connected_3h');
  assert.equal(skipped.attempts, 0);
  assert.equal(summary.skips.recorded, 1);
});

test('what sendTemplate receives: the copy, the facts, enforceGap, and the run clock', async () => {
  const admin = createFakeAdmin(merge(connectedBoth('c')));
  const seen: Array<{ input: SendTemplateInput; deps: Record<string, any> }> = [];
  const sendTemplate: SendTemplateFn = async (input, deps) => {
    seen.push({ input, deps: deps as Record<string, any> });
    return { status: 'sent' };
  };
  await go(admin, { sendTemplate, sendTemplateDeps: { resend: 'fake-resend' } });

  assert.equal(seen.length, 1);
  const { input, deps } = seen[0]!;
  assert.equal(input.enforceGap, true);
  assert.equal(input.templateKey, 'connected_1d');
  assert.equal(input.copy.key, 'connected_1d');
  assert.deepEqual(input.user, { id: 'c', email: 'c@example.com', name: 'سلمان العتيبي', messages_opt_out: false });
  assert.equal(input.facts.firstName, 'سلمان');
  assert.equal(deps.supabase, admin);
  assert.equal(deps.now().getTime(), NOW.getTime());
  assert.equal(deps.resend, 'fake-resend');
});

test('the facts a copy requires are asked for', async () => {
  const admin = createFakeAdmin({
    users: [user('p', 'analysis_viewed')],
    user_events: [event('p', 'first_analysis_viewed', '2026-10-13T10:00')],
  });
  const { summary, factCalls } = await go(admin);
  assert.equal(summary.sent, 1);
  assert.deepEqual(factCalls, [{ id: 'p', needs: ['plan'] }]);
});

test('running again straight away sends nothing and writes nothing new', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), connectedBoth('c')));
  await go(admin);
  const rows = admin.tables.message_log!.length;
  const again = await go(admin);
  assert.equal(again.summary.sent, 0);
  assert.equal(again.summary.planned.total, 0);
  assert.deepEqual(again.calls, []);
  assert.equal(admin.tables.message_log!.length, rows);

  const later = await go(admin, { now: new Date(NOW.getTime() + 10 * 60 * 1000) });
  assert.equal(later.summary.sent, 0);
  assert.equal(admin.tables.message_log!.length, rows);
});

test('a duplicate result (someone else claimed it) is counted and not retried as a failure', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a')));
  const { summary } = await go(admin, { sendTemplate: async () => ({ status: 'duplicate' }) });
  assert.equal(summary.duplicate, 1);
  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 0);
});

test('skipped and failed results from sendTemplate are counted apart', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), dueRegistered('b'), dueRegistered('c')));
  const answers: Record<string, Awaited<ReturnType<SendTemplateFn>>> = {
    a: { status: 'skipped', reason: 'min_gap' },
    b: { status: 'failed', reason: 'resend_500' },
    c: { status: 'sent' },
  };
  const { summary } = await go(admin, { sendTemplate: async (input) => answers[input.user.id]! });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 1);
  assert.deepEqual(summary.results.map((r) => r.result).sort(), ['failed:resend_500', 'sent', 'skipped:min_gap']);
});

test('an exception from sendTemplate is a failure of that person, the loop goes on', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), dueRegistered('b')));
  const { summary } = await go(admin, {
    sendTemplate: async (input) => {
      if (input.user.id === 'a') throw new Error('socket hang up');
      return { status: 'sent' };
    },
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 1);
  assert.ok(summary.results.some((r) => r.result === 'failed:send:socket hang up'));
});

test('not_configured stops the loop and is reported, not counted as a skip', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), dueRegistered('b'), dueRegistered('c')));
  let calls = 0;
  const { summary } = await go(admin, {
    sendTemplate: async () => {
      calls += 1;
      return { status: 'not_configured' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.notConfigured, true);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.sent, 0);
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test('a missing required fact is a final skip: claimed, marked skipped, never retried', async () => {
  const admin = createFakeAdmin({
    users: [user('p', 'analysis_viewed')],
    user_events: [event('p', 'first_analysis_viewed', '2026-10-13T10:00')],
  });
  const facts: LoadEmailFactsFn = async () => ({ ...EMPTY_FACTS, firstName: 'سلمان' });
  const first = await go(admin, { facts });
  assert.equal(first.calls.length, 0, 'sendTemplate is never reached');
  assert.equal(first.summary.skipped, 1);
  assert.deepEqual(first.summary.results.map((r) => r.result), ['skipped:missing_facts']);

  const row = logRow(admin, 'p', 'plan_ready_1d')!;
  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'missing_facts:plan');
  assert.equal(row.category, 'lifecycle');
  assert.equal(row.copy_key, 'plan_ready_1d');

  const second = await go(admin, { facts, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.summary.planned.total, 0);
  assert.equal(second.summary.skipped, 0);
});

test('a copy that returns null is a final skip with reason not_applicable', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a')));
  const copy = approvedCopy();
  copy.registered_1d = { ...copy.registered_1d, build: () => null } as EmailCopy;
  const { summary, calls } = await go(admin, { config: { copy } });
  assert.deepEqual(calls, []);
  assert.deepEqual(summary.results.map((r) => r.result), ['skipped:not_applicable']);
  assert.equal(logRow(admin, 'a', 'registered_1d')!.reason, 'not_applicable');
  assert.equal(logRow(admin, 'a', 'registered_1d')!.status, 'skipped');
});

test('a facts loader that throws fails that person without writing a row, so the next run retries', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), dueRegistered('b')));
  const broken: LoadEmailFactsFn = async (_a, u) => {
    if (u.id === 'a') throw new Error('db down');
    return richFacts(_a, u);
  };
  const first = await go(admin, { facts: broken });
  assert.equal(first.summary.failed, 1);
  assert.equal(first.summary.sent, 1);
  assert.equal(logRow(admin, 'a', 'registered_1d'), undefined);

  const second = await go(admin, { now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.summary.sent, 1);
  assert.equal(logRow(admin, 'a', 'registered_1d')!.status, 'sent');
});

// ---------------------------------------------------------------------------
// Re-check right before sending
// ---------------------------------------------------------------------------

test('a user who connected a minute ago is not mailed for the old state', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('d'), connectedBoth('c')));
  beforeSkipWrite(admin, () => {
    // Between planning and sending, d connects Google Ads.
    admin.tables.users!.find((u) => u.id === 'd')!.stage = 'connected';
    admin.tables.user_events!.push(event('d', 'ads_account_connected', '2026-10-14T11:59'));
  });
  const { summary, calls } = await go(admin);
  assert.deepEqual(calls.map((c) => `${c.user.id}:${c.templateKey}`), ['c:connected_1d']);
  assert.equal(summary.sent, 1);
  assert.equal(logRow(admin, 'd', 'registered_1d'), undefined, 'nothing claimed for the stale plan');
});

test('a user suppressed or opted out after planning is not mailed', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), dueRegistered('b'), connectedBoth('c')));
  beforeSkipWrite(admin, () => {
    admin.tables.users!.find((u) => u.id === 'a')!.email_suppressed_at = '2026-10-14T11:59:00Z';
    admin.tables.users!.find((u) => u.id === 'b')!.messages_opt_out = true;
  });
  const { calls } = await go(admin);
  assert.deepEqual(calls.map((c) => c.user.id), ['c']);
});

test('a user who got another optional mail after planning is held back by the gap', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), connectedBoth('c')));
  beforeSkipWrite(admin, () => {
    admin.tables.message_log!.push({
      id: 'x1',
      user_id: 'a',
      channel: 'email',
      template: 'some_other_mail',
      status: 'sent',
      attempts: 1,
      sent_at: riyadh('2026-10-14T11:58').toISOString(),
      updated_at: riyadh('2026-10-14T11:58').toISOString(),
      category: 'lifecycle',
    });
  });
  const { calls } = await go(admin);
  assert.deepEqual(calls.map((c) => c.user.id), ['c']);
});

// ---------------------------------------------------------------------------
// Limits per run
// ---------------------------------------------------------------------------

test('maxSendsPerRun spreads a backlog over runs: earliest due first, nobody twice, nobody lost', async () => {
  const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
  const seed = merge(
    ...users.map((id, i) => ({
      users: [user(id)],
      // u1 registered first, so its step has waited longest.
      user_events: [event(id, 'registration_completed', `2026-10-13T0${i + 1}:00`)],
    }))
  );
  const admin = createFakeAdmin(seed);
  const sentOrder: string[] = [];
  for (let run = 0; run < 3; run += 1) {
    const { summary, calls } = await go(admin, { now: new Date(NOW.getTime() + run * 60_000), config: { maxSendsPerRun: 2 } });
    sentOrder.push(...calls.map((c) => c.user.id));
    if (run === 0) {
      assert.equal(summary.planned.total, 5);
      assert.equal(summary.planned.thisRun, 2);
    }
  }
  assert.deepEqual(sentOrder, ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.equal(admin.tables.message_log!.filter((r) => r.status === 'sent').length, 5);
});

test('the time budget stops a run cleanly; the rest waits for the next run', async () => {
  const admin = createFakeAdmin(merge(dueRegistered('a'), dueRegistered('b'), dueRegistered('c')));
  let t = 0;
  const clock = () => {
    t += 40;
    return t;
  };
  const first = await go(admin, { clock, config: { timeBudgetMs: 100 } });
  assert.equal(first.summary.timeBudgetExceeded, true);
  assert.equal(first.summary.sent, 2);
  assert.equal(admin.tables.message_log!.filter((r) => r.status === 'sent').length, 2);

  const second = await go(admin, { now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.summary.timeBudgetExceeded, false);
  assert.equal(second.summary.sent, 1);
});

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------

test('the weekly report goes to trialing and active subscribers once per week', async () => {
  const seed = merge(
    { users: [user('act', 'subscribed')], subscriptions: [subscription('act', 'active')], user_events: [event('act', 'subscription_paid', '2026-09-15T10:00')] },
    { users: [user('tri', 'analysis_viewed')], subscriptions: [subscription('tri', 'trialing', { created_at: riyadh('2026-10-11T10:00').toISOString() })] },
    { users: [user('can', 'subscribed')], subscriptions: [subscription('can', 'canceled', { canceled_at: riyadh('2026-10-01T10:00').toISOString() })], user_events: [event('can', 'subscription_paid', '2026-09-15T10:00')] },
    withReports('act', 'tri', 'can')
  );
  const admin = createFakeAdmin(seed);
  const first = await go(admin, { now: SUNDAY });
  assert.deepEqual(first.calls.map((c) => `${c.user.id}:${c.templateKey}`).sort(), ['act:weekly_report_2026-W42', 'tri:weekly_report_2026-W42']);
  assert.deepEqual(first.calls.map((c) => c.copy.key), ['weekly_report', 'weekly_report']);
  assert.deepEqual(first.summary.planned.byTemplate, { weekly_report: 2 });
  assert.deepEqual(first.factCalls.map((f) => f.needs), [['weekly'], ['weekly']]);

  const again = await go(admin, { now: new Date(SUNDAY.getTime() + 60 * 60 * 1000) });
  assert.equal(again.summary.sent, 0);

  const monday = await go(admin, { now: riyadh('2026-10-19T10:00') });
  assert.equal(monday.summary.sent, 0, 'same ISO week, same key');
});

test('the weekly report is only looked for while its slot is open', async () => {
  const admin = createFakeAdmin({ users: [user('act', 'subscribed')], subscriptions: [subscription('act', 'active')] });
  const wed = await go(admin, { dryRun: true });
  assert.equal(wed.summary.considered, 0, 'no slot on a Wednesday: nobody is even loaded');
  const sun = await go(admin, { dryRun: true, now: SUNDAY });
  assert.equal(sun.summary.considered, 1);
});

test('safety net: a weekly report that vanishes between planning and sending stays unclaimed while the slot is open, and a later run sends it', async () => {
  // The planner saw this week's report (it is stored), but the facts read at send time cannot find it: the race.
  const admin = createFakeAdmin(merge({ users: [user('act', 'subscribed')], subscriptions: [subscription('act', 'active')] }, withReports('act')));
  const none: LoadEmailFactsFn = async () => ({ ...EMPTY_FACTS });

  // Not a final answer.
  const sunday = await go(admin, { now: SUNDAY, facts: none });
  assert.deepEqual(sunday.summary.results.map((r) => r.result), ['skipped:weekly_pending']);
  assert.equal(sunday.calls.length, 0);
  assert.equal(logRow(admin, 'act', 'weekly_report_2026-W42'), undefined, 'no permanent skip is written');

  // Still missing an hour later: still unclaimed.
  const hourLater = await go(admin, { now: new Date(SUNDAY.getTime() + 60 * 60 * 1000), facts: none });
  assert.deepEqual(hourLater.summary.results.map((r) => r.result), ['skipped:weekly_pending']);
  assert.equal(logRow(admin, 'act', 'weekly_report_2026-W42'), undefined);

  // The report lands: the next run sends it, once.
  const sent = await go(admin, { now: new Date(SUNDAY.getTime() + 2 * 60 * 60 * 1000) });
  assert.deepEqual(sent.calls.map((c) => c.templateKey), ['weekly_report_2026-W42']);
  assert.equal(logRow(admin, 'act', 'weekly_report_2026-W42')!.status, 'sent');
  const again = await go(admin, { now: new Date(SUNDAY.getTime() + 3 * 60 * 60 * 1000) });
  assert.equal(again.summary.sent, 0);

  admin.tables.reports!.push(weeklyReportRow('act', new Date('2026-10-24T00:30:00Z')));
  const nextSunday = await go(admin, { now: riyadh('2026-10-25T10:00') });
  assert.deepEqual(nextSunday.calls.map((c) => c.templateKey), ['weekly_report_2026-W43']);
});

test('a planned weekly report that never loads is dropped when the slot closes, still without a skip row', async () => {
  const admin = createFakeAdmin(merge({ users: [user('act', 'subscribed')], subscriptions: [subscription('act', 'active')] }, withReports('act')));
  const none: LoadEmailFactsFn = async () => ({ ...EMPTY_FACTS });
  const lastOpen = await go(admin, { now: riyadh('2026-10-20T20:59'), facts: none });
  assert.deepEqual(lastOpen.summary.results.map((r) => r.result), ['skipped:weekly_pending']);

  // 60 hours after Sunday 09:00 is Tuesday 21:00 Riyadh: nothing is planned any more.
  const closed = await go(admin, { now: riyadh('2026-10-20T21:00'), facts: none });
  assert.equal(closed.summary.planned.total, 0);
  assert.deepEqual(closed.summary.results, []);
  assert.deepEqual(admin.tables.message_log ?? [], []);
});

test('a subscriber whose weekly report does not exist yet is not offered it, so their journey step is not blocked', async () => {
  // Trial started Sat 17 Oct 12:00: trial_d1 is due Sun 18 Oct 12:00. The weekly slot opened at 09:00 and has waited
  // longer, so before the fix it came first, found no report ("weekly_pending", no log row) and trial_d1 never went out.
  const trialStart = riyadh('2026-10-17T12:00').toISOString();
  const admin = createFakeAdmin({
    users: [user('tri', 'analysis_viewed')],
    subscriptions: [subscription('tri', 'trialing', { created_at: trialStart })],
    // The account is linked; the optimize cron has not written this week's report yet.
    ...adsAccountSeed(['tri']),
    reports: [],
  });
  const noon = riyadh('2026-10-18T12:00');
  const { summary, calls } = await go(admin, { now: noon, facts: noWeeklyFact });

  assert.deepEqual(calls.map((c) => `${c.user.id}:${c.templateKey}`), ['tri:trial_d1']);
  assert.deepEqual(summary.results.map((r) => r.result), ['sent']);
  assert.equal(logRow(admin, 'tri', 'trial_d1')!.status, 'sent');
  assert.equal(logRow(admin, 'tri', 'weekly_report_2026-W42'), undefined);

  // Once the report is written the weekly goes out, after the 24 hour gap.
  admin.tables.reports!.push(weeklyReportRow('tri', REPORT_W42));
  const next = await go(admin, { now: riyadh('2026-10-19T12:00') });
  assert.deepEqual(next.calls.map((c) => c.templateKey), ['weekly_report_2026-W42']);
});

test('subscribers without a report do not use up the run cap: the person with a journey step is still mailed', async () => {
  // Three subscribers (weekly due Sun 09:00) and one registered user whose registered_1d is due Sun 10:00. The cap is 3
  // and sends are ordered by due time, so three report-less weeklies used to take every slot of every run.
  const subscribers = ['s1', 's2', 's3'].map((id) => ({ users: [user(id, 'subscribed')], subscriptions: [subscription(id, 'active')] }));
  const admin = createFakeAdmin(
    merge(...subscribers, { users: [user('reg')], user_events: [event('reg', 'registration_completed', '2026-10-17T10:00')] })
  );
  const { summary, calls } = await go(admin, { now: riyadh('2026-10-18T12:00'), facts: noWeeklyFact, config: { maxSendsPerRun: 3 } });

  assert.deepEqual(calls.map((c) => `${c.user.id}:${c.templateKey}`), ['reg:registered_1d']);
  assert.equal(summary.ignored.no_weekly_report, 3);
  assert.deepEqual(summary.results.map((r) => r.result), ['sent']);
});

test('a subscriber whose weekly report exists still gets it, and only the one with a report', async () => {
  const subscribers = ['has', 'lacks'].map((id) => ({ users: [user(id, 'subscribed')], subscriptions: [subscription(id, 'active')] }));
  const admin = createFakeAdmin(merge(...subscribers, withReports('has'), adsAccountSeed(['lacks'])));
  const { summary, calls } = await go(admin, { now: riyadh('2026-10-18T12:00') });

  assert.deepEqual(calls.map((c) => `${c.user.id}:${c.templateKey}`), ['has:weekly_report_2026-W42']);
  assert.deepEqual(summary.planned.byTemplate, { weekly_report: 1 });
  assert.equal(summary.ignored.no_weekly_report, 1);
});

test('a missing journey fact is still a final skip (only the weekly report waits for its data)', async () => {
  const admin = createFakeAdmin({
    users: [user('p', 'analysis_viewed')],
    user_events: [event('p', 'first_analysis_viewed', '2026-10-13T10:00')],
  });
  const facts: LoadEmailFactsFn = async () => ({ ...EMPTY_FACTS });
  const result = await go(admin, { facts });
  assert.deepEqual(result.summary.results.map((r) => r.result), ['skipped:missing_facts']);
  assert.equal(logRow(admin, 'p', 'plan_ready_1d')!.reason, 'missing_facts:plan');
});

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

const chatRelaunch = (overrides: Partial<Broadcast> = {}): Broadcast => ({
  id: 'chat_relaunch',
  copyKey: 'broadcast_chat_relaunch',
  segment: 'registered_not_connected',
  notBefore: null,
  approved: true,
  ...overrides,
});

test('a broadcast goes out in batches, each person once, the rest on later runs', async () => {
  const ids = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const admin = createFakeAdmin({ users: ids.map((id) => user(id)) });
  const order: string[] = [];
  for (let run = 0; run < 4; run += 1) {
    const { summary, calls } = await go(admin, {
      now: new Date(NOW.getTime() + run * 60_000),
      config: { broadcasts: [chatRelaunch()], broadcastBatchPerRun: 2 },
    });
    order.push(...calls.map((c) => c.user.id));
    assert.deepEqual(summary.broadcasts, [{ id: 'chat_relaunch', gate: 'ready', planned: run < 2 ? 2 : run === 2 ? 1 : 0 }]);
  }
  assert.deepEqual(order, ids);
  assert.equal(admin.tables.message_log!.filter((r) => r.template === 'broadcast_chat_relaunch' && r.status === 'sent').length, 5);
  assert.deepEqual(new Set(admin.tables.message_log!.map((r) => r.template)), new Set(['broadcast_chat_relaunch']));
});

test('a closed broadcast sends nothing and writes nothing', async () => {
  const admin = createFakeAdmin({ users: [user('b1')] });
  for (const closed of [chatRelaunch({ approved: false }), chatRelaunch({ notBefore: '2026-10-15T00:00:00+03:00' })]) {
    const { summary, calls } = await go(admin, { config: { broadcasts: [closed] } });
    assert.notEqual(summary.broadcasts[0]!.gate, 'ready');
    assert.deepEqual(calls, []);
  }
  assert.equal(admin.tables.message_log!.length, 0);
});

test('journeys come first: a person with a journey mail this run is not also sent the broadcast', async () => {
  const seed = merge(dueRegistered('a'), { users: [user('z')] });
  const admin = createFakeAdmin(seed);
  const { summary, calls } = await go(admin, { config: { broadcasts: [chatRelaunch()] } });
  assert.deepEqual(calls.map((c) => `${c.user.id}:${c.templateKey}`).sort(), ['a:registered_1d', 'z:broadcast_chat_relaunch']);
  assert.deepEqual(summary.planned.byKind, { journey: 1, weekly: 0, broadcast: 1 });

  const next = await go(admin, { now: new Date(NOW.getTime() + 60_000), config: { broadcasts: [chatRelaunch()] } });
  assert.equal(next.summary.sent, 0, 'a now sits inside the 24 hour gap');
  assert.equal(next.summary.ignored.min_gap > 0, true);
});

test('the broadcast batch shares the per-run cap with journeys', async () => {
  const admin = createFakeAdmin({ users: ['b1', 'b2', 'b3', 'b4'].map((id) => user(id)) });
  const { summary } = await go(admin, { config: { broadcasts: [chatRelaunch()], broadcastBatchPerRun: 10, maxSendsPerRun: 3 } });
  assert.equal(summary.sent, 3);
});

test('a broadcast does not need the activation date to have passed for each person, but it needs a global activation moment', async () => {
  const admin = createFakeAdmin({ users: [user('b1')] });
  const off = await go(admin, { config: { activatedAt: null, broadcasts: [chatRelaunch()] } });
  assert.equal(off.summary.sent, 0);
  const on = await go(admin, { config: { activatedAt: riyadh('2026-10-14T11:00').toISOString(), broadcasts: [chatRelaunch()] } });
  assert.equal(on.summary.sent, 1);
});

test('a broadcast stays closed until the activation moment has arrived: nothing is sent or written', async () => {
  const admin = createFakeAdmin({ users: [user('b1')] });
  const future = riyadh('2026-10-14T13:00').toISOString();
  const early = await go(admin, { config: { activatedAt: future, broadcasts: [chatRelaunch()] } });
  assert.deepEqual(early.summary.broadcasts, [{ id: 'chat_relaunch', gate: 'not_activated', planned: 0 }]);
  assert.equal(early.summary.sent, 0);
  assert.deepEqual(early.calls, []);
  assert.equal(admin.tables.message_log!.length, 0);

  const open = await go(admin, { config: { activatedAt: riyadh('2026-10-14T12:00').toISOString(), broadcasts: [chatRelaunch()] } });
  assert.equal(open.summary.broadcasts[0]!.gate, 'ready');
  assert.equal(open.summary.sent, 1);
});

test('permanent blockers of a broadcast are recorded once and not scanned again', async () => {
  const admin = createFakeAdmin({
    users: [user('s', 'registered', { email_suppressed_at: '2026-10-01T00:00:00Z' }), user('o', 'registered', { messages_opt_out: true }), user('ok')],
  });
  const first = await go(admin, { config: { broadcasts: [chatRelaunch()] } });
  assert.equal(first.summary.sent, 1);
  assert.equal(first.summary.skips.permanent, 2);
  assert.equal(logRow(admin, 's', 'broadcast_chat_relaunch')!.reason, 'suppressed');
  assert.equal(logRow(admin, 'o', 'broadcast_chat_relaunch')!.reason, 'opted_out');

  const second = await go(admin, { now: new Date(NOW.getTime() + 60_000), config: { broadcasts: [chatRelaunch()] } });
  assert.equal(second.summary.skips.permanent, 0);
  assert.equal(second.summary.skips.recorded, 0);
});

// ---------------------------------------------------------------------------
// Cost: queries do not grow with the number of people
// ---------------------------------------------------------------------------

test('no N+1: the number of reads depends on chunks of 150 people, not on people', async () => {
  const world = (count: number) => {
    const users = Array.from({ length: count }, (_, i) => user(`n${String(i).padStart(4, '0')}`));
    return {
      users,
      user_events: users.map((u) => event(u.id, 'registration_completed', '2026-10-13T10:00')),
    };
  };
  const reads = async (count: number) => {
    const admin = createFakeAdmin(world(count));
    const touched = spyOnTables(admin);
    const { summary } = await go(admin, { dryRun: true });
    assert.equal(summary.planned.total, count);
    return touched.length;
  };
  const small = await reads(10);
  const sameChunk = await reads(140);
  const threeChunks = await reads(400);
  assert.equal(sameChunk, small);
  assert.equal(threeChunks - small, 2 * 5, 'two more chunks, five reads each');
});
