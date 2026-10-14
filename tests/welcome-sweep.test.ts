import assert from 'node:assert/strict';
import test from 'node:test';
import { sendDueWelcomeEmails, type WelcomeSweepOptions } from '../lib/messaging/welcome';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import type { EmailCopy } from '../lib/lifecycle/types';
import { createFakeAdmin } from './support/fake-admin';
import { withEnv } from './support/with-env';

const NOW = new Date('2026-10-14T10:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
const ACTIVATED = '2026-10-01T00:00:00+03:00';
const approved: EmailCopy = { ...EMAIL_COPY.welcome_ads_connect, approved: true };
const secrets = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com', WELCOME_REPLY_TO_EMAIL: undefined };

type Person = {
  id: string;
  hoursAgo: number;
  handled?: boolean;
  /** The one-click stop (users.messages_opt_out). */
  optOut?: boolean;
  /** A bounced address (users.email_suppressed_at). */
  suppressed?: boolean;
  /** The preferences page switch for the welcome's own category. */
  onboardingOff?: boolean;
};

/** People who registered `hoursAgo` hours ago; `handled` ones already have a sent welcome in message_log. */
function setup(people: Person[]) {
  const users = people.map((p) => ({
    id: p.id,
    email: `${p.id}@example.com`,
    name: 'سلمان العتيبي',
    messages_opt_out: p.optOut === true,
    email_prefs: p.onboardingOff ? { onboarding: false } : {},
    email_suppressed_at: p.suppressed ? hoursAgo(100) : null,
  }));
  const user_events = people.map((p, i) => ({
    id: `ev-${String(i + 1).padStart(4, '0')}`,
    user_id: p.id,
    event: 'registration_completed',
    created_at: hoursAgo(p.hoursAgo),
  }));
  const message_log = people
    .filter((p) => p.handled)
    .map((p) => ({ id: `log-${p.id}`, user_id: p.id, channel: 'email', template: 'welcome_ads_connect', status: 'sent', attempts: 1, sent_at: hoursAgo(p.hoursAgo - 0.1), updated_at: hoursAgo(p.hoursAgo - 0.1) }));

  const admin = createFakeAdmin({ users, user_events, message_log });
  admin.setClock(() => NOW);
  let touched = 0;
  const from = admin.from.bind(admin);
  admin.from = ((table: string) => {
    touched += 1;
    return from(table);
  }) as typeof admin.from;
  const rpc = admin.rpc.bind(admin);
  admin.rpc = (async (name: string, args: any) => {
    touched += 1;
    return rpc(name, args);
  }) as typeof admin.rpc;

  const sent: Array<{ to: string }> = [];
  const options: WelcomeSweepOptions = {
    now: NOW,
    env: { EMAIL_LIFECYCLE_ENABLED: 'true' },
    activatedAt: ACTIVATED,
    copy: approved,
    deps: {
      emailConfigured: () => true,
      now: () => NOW,
      sendEmail: async (payload: any) => {
        sent.push({ to: payload.to });
        return { sent: true, id: `re_${sent.length}` };
      },
    },
  };
  return { admin, sent, options, touched: () => touched };
}

/** Tracked links only accept uuid user ids, so the tests use uuids built from a hex tag. */
const uid = (tag: string | number) => `00000000-0000-4000-8000-${(typeof tag === 'number' ? tag.toString(16) : tag).padStart(12, '0')}`;
const mailedIds = (sent: Array<{ to: string }>) => sent.map((s) => s.to.replace('@example.com', '')).sort();
const idsOf = (people: Person[]) => people.map((p) => p.id).sort();

// ---------------------------------------------------------------------------
// The sweep obeys the same switches as the rest of the lifecycle
// ---------------------------------------------------------------------------

test('welcome sweep: with EMAIL_LIFECYCLE_ENABLED unset (or anything but "true") it reads nothing and sends nothing', () =>
  withEnv(secrets, async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      const { admin, sent, options, touched } = setup([{ id: uid('a'), hoursAgo: 1 }]);
      const summary = await sendDueWelcomeEmails(admin, { ...options, env: { EMAIL_LIFECYCLE_ENABLED: value } });
      assert.deepEqual(summary, { checked: 0, sent: 0, skipped: 0, duplicate: 0, failed: 0, not_configured: 0 }, String(value));
      assert.equal(touched(), 0, `no reads or writes for ${String(value)}`);
      assert.deepEqual(sent, []);
      assert.deepEqual(admin.tables.message_log, []);
    }
  }));

test('welcome sweep: no activation moment, an unreadable one, or one in the future sends nothing and touches nothing', () =>
  withEnv(secrets, async () => {
    for (const activatedAt of [null, 'soon', new Date(NOW.getTime() + 1000).toISOString()]) {
      const { admin, sent, options, touched } = setup([{ id: uid('a'), hoursAgo: 1 }]);
      const summary = await sendDueWelcomeEmails(admin, { ...options, activatedAt });
      assert.equal(summary.sent + summary.checked, 0, String(activatedAt));
      assert.equal(touched(), 0, String(activatedAt));
      assert.deepEqual(sent, []);
    }
  }));

test('welcome sweep: the shipped config (not activated) sends nothing even with the switch on', () =>
  withEnv(secrets, async () => {
    const { admin, sent, options, touched } = setup([{ id: uid('a'), hoursAgo: 1 }]);
    const { activatedAt: _ignored, ...withoutOverride } = options;
    const summary = await sendDueWelcomeEmails(admin, withoutOverride);
    assert.equal(summary.sent, 0);
    assert.equal(touched(), 0);
    assert.deepEqual(sent, []);
  }));

test('welcome sweep: unapproved copy reads nothing and sends nothing (the shipped copy state)', () =>
  withEnv(secrets, async () => {
    const { admin, sent, options, touched } = setup([{ id: uid('a'), hoursAgo: 1 }]);
    const summary = await sendDueWelcomeEmails(admin, { ...options, copy: { ...EMAIL_COPY.welcome_ads_connect, approved: false } });
    assert.equal(summary.checked, 0);
    assert.equal(touched(), 0);
    assert.deepEqual(sent, []);
  }));

test('welcome sweep: registrations from before the activation moment are never mailed', () =>
  withEnv(secrets, async () => {
    const { admin, sent, options } = setup([
      { id: uid('a1'), hoursAgo: 10 },
      { id: uid('a2'), hoursAgo: 5 },
      { id: uid('b1'), hoursAgo: 1 },
      { id: uid('b2'), hoursAgo: 0.5 },
    ]);
    // Activated two hours ago: the 10 h and 5 h old registrations are inside the 48 h catch-up window but before it.
    const summary = await sendDueWelcomeEmails(admin, { ...options, activatedAt: hoursAgo(2) });
    assert.deepEqual(mailedIds(sent), [uid('b1'), uid('b2')].sort());
    assert.equal(summary.sent, 2);
    assert.equal(admin.tables.message_log.filter((r) => r.user_id === uid('a1') || r.user_id === uid('a2')).length, 0);
  }));

test('welcome sweep: an event at exactly the activation moment counts, one a few seconds earlier does not', () =>
  withEnv(secrets, async () => {
    const { admin, sent, options } = setup([
      { id: uid('e'), hoursAgo: 2 },
      { id: uid('f'), hoursAgo: 2.001 },
    ]);
    await sendDueWelcomeEmails(admin, { ...options, activatedAt: hoursAgo(2) });
    assert.deepEqual(mailedIds(sent), [uid('e')]);
  }));

// ---------------------------------------------------------------------------
// It sends, once, and does not starve
// ---------------------------------------------------------------------------

test('welcome sweep: mails a new registration once and a second sweep sends nothing more', () =>
  withEnv(secrets, async () => {
    const { admin, sent, options } = setup([{ id: uid('a'), hoursAgo: 1 }]);
    assert.equal((await sendDueWelcomeEmails(admin, options)).sent, 1);
    assert.equal((await sendDueWelcomeEmails(admin, options)).sent, 0);
    assert.deepEqual(mailedIds(sent), [uid('a')]);
  }));

test('welcome sweep: a connected user is not mailed', () =>
  withEnv(secrets, async () => {
    const { admin, sent, options } = setup([{ id: uid('a'), hoursAgo: 3 }, { id: uid('b'), hoursAgo: 2 }]);
    admin.tables.user_events!.push({ id: 'ev-c', user_id: uid('a'), event: 'ads_account_connected', created_at: hoursAgo(1) });
    await sendDueWelcomeEmails(admin, options);
    assert.deepEqual(mailedIds(sent), [uid('b')]);
  }));

test('welcome sweep: with 30 sign-ups where the oldest 25 are already handled, the 5 newest still get their mail', () =>
  withEnv(secrets, async () => {
    const people: Person[] = Array.from({ length: 30 }, (_, i) => ({ id: uid(i), hoursAgo: 40 - i, handled: i < 25 }));
    const { admin, sent, options } = setup(people);
    const summary = await sendDueWelcomeEmails(admin, { ...options, limit: 25 });
    assert.deepEqual(mailedIds(sent), idsOf(people.slice(25)));
    assert.equal(summary.sent, 5);
  }));

test('welcome sweep: reads past the first page, so 130 handled sign-ups cannot hide the newest ones', () =>
  withEnv(secrets, async () => {
    const people: Person[] = Array.from({ length: 135 }, (_, i) => ({ id: uid(i), hoursAgo: 47 - i * 0.3, handled: i < 130 }));
    const { admin, sent, options } = setup(people);
    await sendDueWelcomeEmails(admin, options);
    assert.deepEqual(mailedIds(sent), idsOf(people.slice(130)));
  }));

test('welcome sweep: one run mails at most `limit` people, oldest first, and the next run takes the rest', () =>
  withEnv(secrets, async () => {
    const people: Person[] = Array.from({ length: 12 }, (_, i) => ({ id: uid(i), hoursAgo: 20 - i }));
    const { admin, sent, options } = setup(people);
    await sendDueWelcomeEmails(admin, { ...options, limit: 5 });
    assert.deepEqual(mailedIds(sent), idsOf(people.slice(0, 5)));
    await sendDueWelcomeEmails(admin, { ...options, limit: 5 });
    assert.equal(sent.length, 10);
    await sendDueWelcomeEmails(admin, { ...options, limit: 5 });
    assert.equal(sent.length, 12);
  }));

// ---------------------------------------------------------------------------
// People who can never be mailed must not use up the run's slots
// ---------------------------------------------------------------------------

test('welcome sweep: 25 older sign-ups who opted out cannot starve the newer one', () =>
  withEnv(secrets, async () => {
    // sendTemplate turns an opted-out person away without a log row, so they stay "due" forever. Before they were
    // filtered ahead of the limit, the oldest 25 of them took every slot of every run and the 26th was never mailed.
    const people: Person[] = [
      ...Array.from({ length: 25 }, (_, i) => ({ id: uid(i), hoursAgo: 40 - i, optOut: true })),
      { id: uid('ff'), hoursAgo: 2 },
    ];
    const { admin, sent, options } = setup(people);
    const summary = await sendDueWelcomeEmails(admin, { ...options, limit: 25 });
    assert.deepEqual(mailedIds(sent), [uid('ff')]);
    assert.equal(summary.sent, 1);
    assert.equal(summary.checked, 1, 'the opted-out people are not even tried');
    assert.deepEqual(admin.tables.message_log.filter((r) => r.user_id !== uid('ff')), []);
  }));

test('welcome sweep: suppressed addresses and a switched-off onboarding category are filtered the same way', () =>
  withEnv(secrets, async () => {
    const people: Person[] = [
      ...Array.from({ length: 13 }, (_, i) => ({ id: uid(i), hoursAgo: 40 - i, suppressed: true })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: uid(100 + i), hoursAgo: 30 - i, onboardingOff: true })),
      { id: uid('ff'), hoursAgo: 2 },
    ];
    const { admin, sent, options } = setup(people);
    await sendDueWelcomeEmails(admin, { ...options, limit: 25 });
    assert.deepEqual(mailedIds(sent), [uid('ff')]);
  }));

test('welcome sweep: before the lifecycle migration (no email_suppressed_at / email_prefs columns) the opt-out flag still keeps people out of the slots', () =>
  withEnv(secrets, async () => {
    const people: Person[] = [
      ...Array.from({ length: 25 }, (_, i) => ({ id: uid(i), hoursAgo: 40 - i, optOut: true })),
      { id: uid('ff'), hoursAgo: 2 },
    ];
    const { admin, sent, options } = setup(people);
    const from = admin.from.bind(admin);
    admin.from = ((table: string) => {
      const query = from(table);
      if (table !== 'users') return query;
      const select = query.select.bind(query);
      query.select = ((columns?: string) => {
        // Only the sweep's own read (it starts with `id`); sendTemplate reads the preference row itself, later.
        if (typeof columns === 'string' && columns.startsWith('id,') && columns.includes('email_suppressed_at')) {
          query.then = ((resolve: any) => Promise.resolve(resolve({ data: null, error: { code: '42703', message: 'column users.email_suppressed_at does not exist' } }))) as typeof query.then;
        }
        return select();
      }) as typeof query.select;
      return query;
    }) as typeof admin.from;

    const summary = await sendDueWelcomeEmails(admin, { ...options, limit: 25 });
    assert.deepEqual(mailedIds(sent), [uid('ff')]);
    assert.equal(summary.sent, 1);
  }));

test('welcome sweep: any other users read error is still a clear exception', () =>
  withEnv(secrets, async () => {
    const { admin, options } = setup([{ id: uid('a'), hoursAgo: 1 }]);
    const from = admin.from.bind(admin);
    admin.from = ((table: string) => {
      const query = from(table);
      if (table === 'users') query.then = ((resolve: any) => Promise.resolve(resolve({ data: null, error: { code: '57014', message: 'canceling statement' } }))) as typeof query.then;
      return query;
    }) as typeof admin.from;
    await assert.rejects(sendDueWelcomeEmails(admin, options), /welcome sweep: lookup failed: canceling statement/);
  }));
