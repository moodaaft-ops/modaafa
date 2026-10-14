import assert from 'node:assert/strict';
import test from 'node:test';
import { riyadhHour } from '../lib/lifecycle/riyadh';
import { runEmailLifecycle } from '../lib/lifecycle/run';
import { createFakeAdmin } from './support/fake-admin';
import { ACTIVATED_AT, approvedCopy, fakeSendTemplate, richFacts } from './support/lifecycle';

/**
 * Thirty days of the real runner, every 15 minutes, over a small population in
 * every state the journeys know about. The clock, the database and the sender
 * are fakes; everything else (candidate queries, planning, re-check, claim,
 * skip rows) is the production path. It checks the promises that matter to a
 * human inbox, not the internals:
 *
 *   - never two optional mails within 24 hours
 *   - never more than 3 optional mails in any 7 days
 *   - only between 09:00 and 22:00 Riyadh time
 *   - only the journey the person is in, in order, once each
 *   - nothing for people who opted out, are suppressed or are held out
 */
const DAY = 24 * 60 * 60 * 1000;
const D0 = new Date('2026-10-12T00:00:00+03:00'); // a Monday
const CADENCE = 15 * 60 * 1000;
const DAYS = 30;

const at = (day: number, time: string) => new Date(D0.getTime() + day * DAY + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))) * 60 * 1000);

type Row = Record<string, any>;
type Change = { when: Date; apply: (tables: Record<string, Row[]>) => void };

function userRow(id: string, extra: Row = {}): Row {
  return { id, email: `${id}@example.com`, name: 'سلمان العتيبي', stage: 'registered', messages_opt_out: false, email_prefs: {}, email_suppressed_at: null, ...extra };
}

const changes: Change[] = [];
const on = (when: Date, apply: Change['apply']) => changes.push({ when, apply });

const event = (userId: string, name: string, when: Date, tables: Record<string, Row[]>) => {
  tables.user_events!.push({ id: `ev-${tables.user_events!.length + 1}`, user_id: userId, event: name, created_at: when.toISOString() });
};
const stage = (userId: string, value: string, tables: Record<string, Row[]>) => {
  tables.users!.find((u) => u.id === userId)!.stage = value;
};
const subscribe = (userId: string, status: string, when: Date, tables: Record<string, Row[]>, extra: Row = {}) => {
  tables.subscriptions!.push({
    id: `sub-${userId}`,
    user_id: userId,
    status,
    created_at: when.toISOString(),
    trial_ends_at: null,
    canceled_at: null,
    last_event_at: when.toISOString(),
    ...extra,
  });
};
const patchSubscription = (userId: string, patch: Row, tables: Record<string, Row[]>) => {
  Object.assign(tables.subscriptions!.find((s) => s.user_id === userId)!, patch);
};

const USERS = ['r1', 'r2', 'r3', 'c1', 'p1', 't1', 't2', 'l1', 'x1', 'd1', 'b1', 'o1', 's1', 'h1'];

// r1: registers Monday morning, never connects. Has the welcome mail from minute five.
on(at(0, '10:00'), (t) => event('r1', 'registration_completed', at(0, '10:00'), t));
// r2: registers just before midnight, so every step is due outside the window.
on(at(0, '23:30'), (t) => event('r2', 'registration_completed', at(0, '23:30'), t));
// r3: registers late in the month.
on(at(22, '10:00'), (t) => event('r3', 'registration_completed', at(22, '10:00'), t));
// c1: connects two hours after registering.
on(at(0, '10:00'), (t) => event('c1', 'registration_completed', at(0, '10:00'), t));
on(at(0, '12:00'), (t) => {
  event('c1', 'ads_account_connected', at(0, '12:00'), t);
  stage('c1', 'connected', t);
});
// p1: sees the plan on day 0 and does nothing more.
on(at(0, '10:00'), (t) => event('p1', 'registration_completed', at(0, '10:00'), t));
on(at(0, '11:00'), (t) => {
  event('p1', 'ads_account_connected', at(0, '11:00'), t);
  stage('p1', 'connected', t);
});
on(at(0, '13:00'), (t) => {
  event('p1', 'first_analysis_viewed', at(0, '13:00'), t);
  stage('p1', 'analysis_viewed', t);
});
// t1: starts a trial on day 2 and pays on day 8.
on(at(2, '10:00'), (t) => {
  event('t1', 'first_analysis_viewed', at(2, '09:00'), t);
  stage('t1', 'analysis_viewed', t);
  subscribe('t1', 'trialing', at(2, '10:00'), t);
});
on(at(8, '12:00'), (t) => {
  patchSubscription('t1', { status: 'active', last_event_at: at(8, '12:00').toISOString() }, t);
  event('t1', 'subscription_paid', at(8, '12:00'), t);
  stage('t1', 'subscribed', t);
});
// t2: starts a trial on a Friday, so the weekly report lands the day after the first trial mail.
on(at(4, '09:00'), (t) => {
  event('t2', 'first_analysis_viewed', at(4, '08:00'), t);
  stage('t2', 'analysis_viewed', t);
  subscribe('t2', 'trialing', at(4, '09:00'), t);
});
// l1: trial that asks to cancel on day 3 (cancel_at_period_end) and really ends on day 5. Stripe stamps canceled_at
// with the REQUEST (day 3); the event that writes status canceled, and last_event_at, is the end (day 5).
on(at(1, '10:00'), (t) => {
  event('l1', 'first_analysis_viewed', at(1, '09:00'), t);
  stage('l1', 'analysis_viewed', t);
  subscribe('l1', 'trialing', at(1, '10:00'), t, { trial_ends_at: at(5, '12:00').toISOString() });
});
on(at(5, '12:00'), (t) =>
  patchSubscription('l1', { status: 'canceled', canceled_at: at(3, '12:00').toISOString(), last_event_at: at(5, '12:00').toISOString() }, t)
);
// x1: pays on day 1, asks to cancel on day 6 and the subscription ends on day 8.
on(at(1, '08:00'), (t) => {
  event('x1', 'subscription_paid', at(1, '08:00'), t);
  stage('x1', 'subscribed', t);
  subscribe('x1', 'active', at(1, '08:00'), t);
});
on(at(8, '12:00'), (t) =>
  patchSubscription('x1', { status: 'canceled', canceled_at: at(6, '12:00').toISOString(), last_event_at: at(8, '12:00').toISOString() }, t)
);
// d1: a paying customer whose renewal card fails on day 10. Stripe retries the card and every retry bumps
// last_event_at; the unpaid period (current_period_start) stays at day 10.
on(at(0, '08:00'), (t) => {
  event('d1', 'subscription_paid', at(0, '08:00'), t);
  stage('d1', 'subscribed', t);
  subscribe('d1', 'active', at(0, '08:00'), t);
});
on(at(10, '12:00'), (t) =>
  patchSubscription('d1', { status: 'past_due', current_period_start: at(10, '12:00').toISOString(), last_event_at: at(10, '12:00').toISOString() }, t)
);
for (const retry of [12, 14, 17]) on(at(retry, '12:00'), (t) => patchSubscription('d1', { last_event_at: at(retry, '12:00').toISOString() }, t));
// b1: a trial refused at its start (card already used): written canceled at once, trial end still days away.
// It never was a trial, so there is no "your trial ended" mail.
on(at(3, '10:00'), (t) => {
  event('b1', 'first_analysis_viewed', at(3, '09:00'), t);
  stage('b1', 'analysis_viewed', t);
  subscribe('b1', 'canceled', at(3, '10:00'), t, { trial_ends_at: at(17, '10:00').toISOString(), canceled_at: at(3, '10:00').toISOString() });
});
// o1 opted out, s1 is suppressed, h1 is in the holdout group: all registered on day 0.
for (const id of ['o1', 's1', 'h1']) on(at(0, '10:00'), (t) => event(id, 'registration_completed', at(0, '10:00'), t));

function seed() {
  const users = USERS.map((id) =>
    userRow(id, {
      ...(id === 'o1' ? { messages_opt_out: true } : {}),
      ...(id === 's1' ? { email_suppressed_at: '2026-10-01T00:00:00Z' } : {}),
      ...(id === 't1' || id === 't2' || id === 'l1' ? { stage: 'registered' } : {}),
    })
  );
  const welcome = (userId: string) => ({
    id: `welcome-${userId}`,
    user_id: userId,
    channel: 'email',
    template: 'welcome_ads_connect',
    status: 'sent',
    attempts: 1,
    sent_at: at(0, '10:05').toISOString(),
    updated_at: at(0, '10:05').toISOString(),
    category: 'onboarding',
  });
  return createFakeAdmin({ users, message_log: [welcome('r1'), welcome('c1')] });
}

const local = (iso: string) => {
  const d = new Date(Date.parse(iso) + 3 * 60 * 60 * 1000);
  const day = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2026, 9, 12)) / DAY);
  return `d${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

type Mail = { template: string; sentAt: string; category: string | null };
type Admin = ReturnType<typeof createFakeAdmin>;

/** Runs the cron every 15 minutes between `from` and `to`, except inside `outages` (the cron is down). */
async function drive(admin: Admin, options: { from: Date; to: Date; pending?: Change[]; outages?: Array<[Date, Date]>; heldOut?: (id: string) => boolean }) {
  const fake = fakeSendTemplate(admin);
  const pending = [...(options.pending ?? [])].sort((a, b) => a.when.getTime() - b.when.getTime());
  let runs = 0;
  for (let t = options.from.getTime(); t <= options.to.getTime(); t += CADENCE) {
    const now = new Date(t);
    while (pending.length > 0 && pending[0]!.when.getTime() <= t) pending.shift()!.apply(admin.tables);
    if (options.outages?.some(([start, end]) => t >= start.getTime() && t < end.getTime())) continue;
    admin.setClock(() => now);
    await runEmailLifecycle({
      admin,
      now,
      config: { activatedAt: ACTIVATED_AT, copy: approvedCopy(), broadcasts: [], plan: { isHeldOut: options.heldOut ?? (() => false) } },
      deps: { sendTemplate: fake.fn, loadEmailFacts: richFacts },
    });
    runs += 1;
  }
  return { runs, calls: fake.calls };
}

function mailsOf(admin: Admin): Map<string, Mail[]> {
  const mails = new Map<string, Mail[]>();
  for (const row of admin.tables.message_log!) {
    if (row.status !== 'sent') continue;
    const list = mails.get(row.user_id) ?? [];
    list.push({ template: row.template, sentAt: row.sent_at, category: row.category });
    mails.set(row.user_id, list);
  }
  for (const list of mails.values()) list.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  return mails;
}

let cached: Promise<{ admin: Admin; mails: Map<string, Mail[]>; runs: number }> | null = null;

function simulate() {
  cached ??= (async () => {
    const admin = seed();
    const { runs } = await drive(admin, { from: D0, to: new Date(D0.getTime() + DAYS * DAY), pending: changes, heldOut: (id) => id === 'h1' });
    return { admin, mails: mailsOf(admin), runs };
  })();
  return cached;
}

const sequence = (mails: Map<string, Mail[]>, id: string) => (mails.get(id) ?? []).map((m) => `${m.template} ${local(m.sentAt)}`);

// ---------------------------------------------------------------------------
// The promises, checked over every mail of every person
// ---------------------------------------------------------------------------

test('30 days: the simulation really ran every 15 minutes', async () => {
  const { runs } = await simulate();
  assert.equal(runs, DAYS * 24 * 4 + 1);
});

test('30 days: never two optional mails within 24 hours', async () => {
  const { mails } = await simulate();
  let checked = 0;
  for (const [userId, list] of mails) {
    const optional = list.filter((m) => m.category !== 'transactional');
    for (let i = 1; i < optional.length; i += 1) {
      const gap = Date.parse(optional[i]!.sentAt) - Date.parse(optional[i - 1]!.sentAt);
      assert.ok(gap >= DAY, `${userId}: ${optional[i - 1]!.template} -> ${optional[i]!.template} only ${gap / 3_600_000} h apart`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `only ${checked} pairs were checked; the scenario lost its coverage`);
});

test('30 days: never more than 3 optional mails in any 7 days', async () => {
  const { mails } = await simulate();
  let busiest = 0;
  for (const [userId, list] of mails) {
    const times = list.filter((m) => m.category !== 'transactional').map((m) => Date.parse(m.sentAt));
    for (const end of times) {
      const inWindow = times.filter((t) => t <= end && t > end - 7 * DAY).length;
      busiest = Math.max(busiest, inWindow);
      assert.ok(inWindow <= 3, `${userId}: ${inWindow} mails in the 7 days up to ${local(new Date(end).toISOString())}`);
    }
  }
  assert.equal(busiest, 3, 'the scenario must actually reach the cap, otherwise the check proves nothing');
});

test('30 days: every mail leaves between 09:00 and 22:00 Riyadh time', async () => {
  const { mails } = await simulate();
  let total = 0;
  for (const list of mails.values()) {
    for (const mail of list) {
      const hour = riyadhHour(new Date(mail.sentAt));
      assert.ok(hour >= 9 && hour < 22, `${mail.template} at ${local(mail.sentAt)}`);
      total += 1;
    }
  }
  assert.equal(total, 40, 'the scenario sends exactly the mails its stories describe');
});

test('30 days: nobody gets the same mail twice and every sent row is complete', async () => {
  const { admin } = await simulate();
  const seen = new Set<string>();
  for (const row of admin.tables.message_log!) {
    const key = `${row.user_id}|${row.channel}|${row.template}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.equal(row.status, 'sent', `${key} is ${row.status}`);
    if (row.template !== 'welcome_ads_connect') {
      assert.ok(row.category, `${key} has a category`);
      assert.ok(row.copy_key, `${key} has a copy key`);
    }
  }
});

test('30 days: opted-out, suppressed and held-out people get nothing', async () => {
  const { mails } = await simulate();
  for (const id of ['o1', 's1', 'h1']) assert.deepEqual(mails.get(id) ?? [], [], id);
});

test('30 days: a trial that was refused at its start gets no trial_lapsed mail and no log row', async () => {
  const { admin, mails } = await simulate();
  assert.deepEqual(mails.get('b1') ?? [], []);
  assert.deepEqual(admin.tables.message_log!.filter((row) => row.user_id === 'b1'), []);
});

// ---------------------------------------------------------------------------
// The exact stories (read these as documentation of how the engine behaves)
// ---------------------------------------------------------------------------

test('30 days, registered and never connected: three reminders, the third waits for the 7 day cap', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 'r1'), [
    'welcome_ads_connect d0 10:05',
    'registered_1d d1 10:15', // due 10:00, the welcome mail was sent at 10:05 on day 0
    'registered_3d d3 10:00',
    // Due d7 10:00, but the welcome mail is still inside the 7 day window until d7 10:05.
    'registered_7d d7 10:15',
  ]);
});

test('30 days, registered at 23:30: steps due at night go out at 09:00 the next morning', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 'r2'), ['registered_1d d2 09:00', 'registered_3d d4 09:00', 'registered_7d d8 09:00']);
  assert.deepEqual(sequence(mails, 'r3'), ['registered_1d d23 10:00', 'registered_3d d25 10:00', 'registered_7d d29 10:00']);
});

test('30 days, connected: the 3 hour mail waits out the 24 hour gap after the welcome mail, the next one waits after it', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 'c1'), ['welcome_ads_connect d0 10:05', 'connected_3h d1 10:15', 'connected_1d d2 10:15']);
});

test('30 days, plan ready: a clean one, three and seven days after', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 'p1'), ['plan_ready_1d d1 13:00', 'plan_ready_3d d3 13:00', 'plan_ready_7d d7 13:00']);
});

test('30 days, trial that converts: trial mails stop at payment, the weekly report continues', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 't1'), [
    'trial_d1 d3 10:00',
    'weekly_report_2026-W42 d6 09:00', // Sunday
    'trial_d4 d7 09:00', // due d6 10:00, one day after the weekly report because of the gap
    // paid on d8: trial_d9 (due d11) never goes out
    'weekly_report_2026-W43 d13 09:00',
    'weekly_report_2026-W44 d20 09:00',
    'weekly_report_2026-W45 d27 09:00',
  ]);
});

test('30 days, trial started on a Friday: the weekly report and a trial mail due together take turns', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 't2'), [
    'trial_d1 d5 09:00',
    'weekly_report_2026-W42 d6 09:00', // exactly 24 hours later is allowed
    'trial_d4 d8 09:00',
    'trial_d9 d13 09:00', // due at the same minute as the weekly report; the trial mail goes first
    'weekly_report_2026-W43 d14 09:00', // still inside the weekly report's 60 hour window
    'weekly_report_2026-W44 d20 09:00',
    'weekly_report_2026-W45 d27 09:00',
  ]);
});

test('30 days, trial cancelled: lapsed mails follow the cancellation, the cap delays the first by a day', async () => {
  const { mails } = await simulate();
  assert.deepEqual(sequence(mails, 'l1'), [
    // The simulation starts inside Sunday d-1's weekly slot (60 hours): a new trial gets that week's report.
    'weekly_report_2026-W41 d1 10:00',
    'trial_d1 d2 10:00',
    'trial_d4 d5 10:00',
    // cancelled d5 12:00, so trial_lapsed_2d is due d7 12:00 but three mails sit in the last 7 days
    'trial_lapsed_2d d8 10:00',
    'trial_lapsed_14d d19 12:00',
  ]);
});

test('30 days, paying then cancelled and paying then failing: the right journey for each', async () => {
  const { mails } = await simulate();
  // The cancel was requested on d6 but the subscription ended on d8 12:00, so the mail is due d9 12:00, not d7.
  assert.deepEqual(sequence(mails, 'x1'), ['weekly_report_2026-W41 d1 09:00', 'weekly_report_2026-W42 d6 09:00', 'canceled_1d d9 12:00']);
  // The unpaid period started d10 12:00: access runs out after 7 days (d17 12:00) and the mail follows a day later,
  // whatever the Stripe retries on d12, d14 and d17 did to last_event_at.
  assert.deepEqual(sequence(mails, 'd1'), ['weekly_report_2026-W41 d0 09:00', 'weekly_report_2026-W42 d6 09:00', 'past_due_3d d18 12:00']);
});

test('30 days, trial cancelled: trial_lapsed_14d is due 14 days after the trial really ended, not after the request', async () => {
  const { admin } = await simulate();
  const lapsed = admin.tables.message_log!.find((row) => row.user_id === 'l1' && row.template === 'trial_lapsed_14d');
  assert.equal(local(lapsed!.sent_at), 'd19 12:00');
});

// ---------------------------------------------------------------------------
// Anchored at the moment the subscription really ended
// ---------------------------------------------------------------------------

test('trial_lapsed_2d and canceled_1d go out 2 and 1 days after the subscription ended, not after the cancel request', async () => {
  const k1Flip = at(4, '10:00');
  const k2Flip = at(2, '10:00');
  const admin = createFakeAdmin({
    users: [userRow('k1', { stage: 'analysis_viewed' }), userRow('k2', { stage: 'subscribed' })],
    user_events: [
      { id: 'ev-1', user_id: 'k1', event: 'first_analysis_viewed', created_at: at(2, '09:00').toISOString() },
      { id: 'ev-2', user_id: 'k2', event: 'subscription_paid', created_at: at(0, '08:00').toISOString() },
    ],
    subscriptions: [
      // k2 pays on d0, asks to cancel d1 12:00 and the subscription ends d2 10:00.
      { id: 'sub-k2', user_id: 'k2', status: 'active', created_at: at(0, '08:00').toISOString(), trial_ends_at: null, canceled_at: null, last_event_at: at(0, '08:00').toISOString() },
    ],
  });
  const pending: Change[] = [
    // k1 starts a trial d2 10:00, asks to cancel d3 12:00 (Stripe's canceled_at), and it ends d4 10:00.
    { when: at(2, '10:00'), apply: (t) => subscribe('k1', 'trialing', at(2, '10:00'), t, { trial_ends_at: k1Flip.toISOString() }) },
    { when: k1Flip, apply: (t) => patchSubscription('k1', { status: 'canceled', canceled_at: at(3, '12:00').toISOString(), last_event_at: k1Flip.toISOString() }, t) },
    { when: k2Flip, apply: (t) => patchSubscription('k2', { status: 'canceled', canceled_at: at(1, '12:00').toISOString(), last_event_at: k2Flip.toISOString() }, t) },
  ];
  await drive(admin, { from: D0, to: at(20, '00:00'), pending });
  const mails = mailsOf(admin);

  const offsetDays = (userId: string, template: string, flip: Date) =>
    (Date.parse(mails.get(userId)!.find((m) => m.template === template)!.sentAt) - flip.getTime()) / DAY;
  assert.equal(offsetDays('k1', 'trial_lapsed_2d', k1Flip), 2);
  assert.equal(offsetDays('k1', 'trial_lapsed_14d', k1Flip), 14);
  assert.equal(offsetDays('k2', 'canceled_1d', k2Flip), 1);
  assert.deepEqual(sequence(mails, 'k1'), ['trial_d1 d3 10:00', 'trial_lapsed_2d d6 10:00', 'trial_lapsed_14d d18 10:00']);
  assert.deepEqual(sequence(mails, 'k2'), ['weekly_report_2026-W41 d0 09:00', 'canceled_1d d3 10:00']);
});

// ---------------------------------------------------------------------------
// When the cron is down
// ---------------------------------------------------------------------------

test('after a three day outage the backlog collapses into one mail, never a burst', async () => {
  const admin = createFakeAdmin({ users: [userRow('z')] });
  const pending: Change[] = [{ when: at(0, '10:00'), apply: (t) => event('z', 'registration_completed', at(0, '10:00'), t) }];
  // Down from d0 12:00 to d4 12:00 (Friday). registered_1d (due d1 10:00) expired at d3 10:00;
  // registered_3d (due d3 10:00) is still good until d5 10:00.
  await drive(admin, { from: D0, to: at(12, '00:00'), pending, outages: [[at(0, '12:00'), at(4, '12:00')]] });

  const mails = mailsOf(admin);
  assert.deepEqual(sequence(mails, 'z'), ['registered_3d d4 12:00', 'registered_7d d7 10:00']);
  const skipped = admin.tables.message_log!.filter((r) => r.status === 'skipped');
  assert.deepEqual(skipped.map((r) => `${r.template}:${r.reason}`), ['registered_1d:expired']);
});

test('a long outage loses stale steps for good: nothing from last week arrives late', async () => {
  const admin = createFakeAdmin({ users: [userRow('z')] });
  const pending: Change[] = [{ when: at(0, '10:00'), apply: (t) => event('z', 'registration_completed', at(0, '10:00'), t) }];
  // Down from d0 12:00 to d8 12:00 (Tuesday): registered_1d and registered_3d expired, registered_7d (due d7 10:00) is good until d9 10:00.
  await drive(admin, { from: D0, to: at(12, '00:00'), pending, outages: [[at(0, '12:00'), at(8, '12:00')]] });

  assert.deepEqual(sequence(mailsOf(admin), 'z'), ['registered_7d d8 12:00']);
  const skipped = admin.tables.message_log!.filter((r) => r.status === 'skipped');
  assert.deepEqual(skipped.map((r) => `${r.template}:${r.reason}`).sort(), ['registered_1d:expired', 'registered_3d:expired']);
});

test('after an outage longer than every step lasts, the person is not even loaded and nothing is sent', async () => {
  const admin = createFakeAdmin({ users: [userRow('z')] });
  const pending: Change[] = [{ when: at(0, '10:00'), apply: (t) => event('z', 'registration_completed', at(0, '10:00'), t) }];
  // Back at d10 12:00, which is past the 9 day horizon of the registered journey (7 days + 48 hours).
  await drive(admin, { from: D0, to: at(12, '00:00'), pending, outages: [[at(0, '12:00'), at(10, '12:00')]] });

  assert.equal(mailsOf(admin).size, 0);
  assert.equal(admin.tables.message_log!.length, 0);
  const probe = await runEmailLifecycle({
    admin,
    now: at(12, '12:00'),
    dryRun: true,
    config: { activatedAt: ACTIVATED_AT, copy: approvedCopy(), broadcasts: [] },
  });
  assert.equal(probe.considered, 0);
});
