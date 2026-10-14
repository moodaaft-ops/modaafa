import assert from 'node:assert/strict';
import test from 'node:test';
import { sendTemplate, type SendDeps, type SendTemplateInput } from '../lib/messaging/send';
import { EMPTY_FACTS, type EmailCopy } from '../lib/lifecycle/types';
import { createFakeAdmin } from './support/fake-admin';
import { FIXTURE_USER, WEEKLY_FACTS, statCopy, transactionalCopy } from './support/email-fixtures';
import { withEnv } from './support/with-env';

const env = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com', WELCOME_REPLY_TO_EMAIL: undefined };
const NOW = new Date('2026-10-14T10:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
const U = FIXTURE_USER.id;

const lifecycleCopy: EmailCopy = {
  key: 'registered_1d',
  category: 'lifecycle',
  approved: true,
  build: () => ({
    subject: 'وقفت عند الربط؟',
    preheader: 'خطوة وحدة وتخلص',
    blocks: [{ type: 'p', text: 'نكمل معك الربط.' }],
    cta: { label: 'كمّل الربط', path: '/onboarding/connect' },
    signer: 'team',
  }),
};

function userRow(extra: Record<string, unknown> = {}) {
  return { id: U, email: FIXTURE_USER.email, name: FIXTURE_USER.name, messages_opt_out: false, email_prefs: {}, email_suppressed_at: null, ...extra };
}

function setup(users: Array<Record<string, unknown>> = [userRow()], logs: Array<Record<string, unknown>> = []) {
  const admin = createFakeAdmin({ users, message_log: logs });
  admin.setClock(() => NOW);
  const sent: any[] = [];
  const deps: SendDeps = {
    supabase: admin,
    emailConfigured: () => true,
    now: () => NOW,
    sendEmail: async (payload) => {
      sent.push(payload);
      return { sent: true, id: `re_${sent.length}` };
    },
  };
  const input = (over: Partial<SendTemplateInput> = {}): SendTemplateInput => ({
    user: { id: U, email: FIXTURE_USER.email, name: FIXTURE_USER.name, messages_opt_out: false },
    templateKey: 'registered_1d',
    copy: lifecycleCopy,
    facts: { ...EMPTY_FACTS, firstName: 'سارة' },
    enforceGap: true,
    ...over,
  });
  return { admin, sent, deps, input };
}

const logRow = (over: Record<string, unknown>) => ({
  id: `log-${Math.random()}`, user_id: U, channel: 'email', template: 'welcome_ads_connect', status: 'sent', attempts: 1, sent_at: hoursAgo(2), category: 'lifecycle', ...over,
});

test('sendTemplate sends html and text with tags, headers and an idempotency key, and logs category and copy key', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup();
    const result = await sendTemplate(input(), deps);
    assert.deepEqual(result, { status: 'sent', providerId: 're_1' });
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.to, FIXTURE_USER.email);
    assert.equal(mail.subject, 'وقفت عند الربط؟');
    assert.equal(mail.rawHtml, true);
    assert.match(mail.html, /^<!doctype html>/i);
    assert.match(mail.text, /^هلا سارة،/);
    assert.deepEqual(mail.tags, [
      { name: 'template', value: 'registered_1d' },
      { name: 'category', value: 'lifecycle' },
    ]);
    assert.match(mail.headers['List-Unsubscribe'], /\/api\/messages\/opt-out\?u=/);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.equal(mail.idempotencyKey, `registered_1d-${U}`);

    const row = admin.tables.message_log[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.template, 'registered_1d');
    assert.equal(row.category, 'lifecycle');
    assert.equal(row.copy_key, 'registered_1d');
    assert.equal(row.provider_id, 're_1');
    assert.equal(row.sent_at, NOW.toISOString());
    assert.equal(row.reason, null);
  }));

test('the weekly template key is logged under its own key while copy_key stays the copy key', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup();
    const result = await sendTemplate(
      input({ templateKey: 'weekly_report_2026-W42', copy: statCopy, facts: WEEKLY_FACTS }),
      deps
    );
    assert.equal(result.status, 'sent');
    assert.equal(admin.tables.message_log[0].template, 'weekly_report_2026-W42');
    assert.equal(admin.tables.message_log[0].copy_key, 'weekly_report');
    assert.equal(admin.tables.message_log[0].category, 'weekly_report');
    assert.equal(sent[0].idempotencyKey, `weekly_report_2026-W42-${U}`);
  }));

test('a second call for the same user and template is a duplicate and sends nothing', () =>
  withEnv(env, async () => {
    const { sent, deps, input } = setup();
    assert.equal((await sendTemplate(input(), deps)).status, 'sent');
    assert.deepEqual(await sendTemplate(input({ enforceGap: false }), deps), { status: 'duplicate' });
    assert.equal(sent.length, 1);
  }));

test('two parallel calls: exactly one wins the claim', () =>
  withEnv(env, async () => {
    const { sent, deps, input } = setup();
    const results = await Promise.all([sendTemplate(input(), deps), sendTemplate(input(), deps)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['duplicate', 'sent']);
    assert.equal(sent.length, 1);
  }));

test('a suppressed address gets nothing, billing mail included, and no log row is written', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup([userRow({ email_suppressed_at: '2026-10-01T00:00:00Z' })]);
    assert.deepEqual(await sendTemplate(input(), deps), { status: 'skipped', reason: 'suppressed' });
    assert.deepEqual(
      await sendTemplate(input({ templateKey: 'tx_payment_failed', copy: transactionalCopy, enforceGap: false }), deps),
      { status: 'skipped', reason: 'suppressed' }
    );
    assert.equal(sent.length, 0);
    assert.equal(admin.tables.message_log.length, 0);
  }));

test('a category the user switched off is skipped, the others still go', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup([userRow({ email_prefs: { lifecycle: false } })]);
    assert.deepEqual(await sendTemplate(input(), deps), { status: 'skipped', reason: 'category_off' });
    assert.equal(admin.tables.message_log.length, 0);
    assert.equal(sent.length, 0);

    const weekly = await sendTemplate(input({ templateKey: 'weekly_report_2026-W42', copy: statCopy, facts: WEEKLY_FACTS }), deps);
    assert.equal(weekly.status, 'sent');
  }));

test('the one-click stop (messages_opt_out) turns every optional category off, from the row or from the caller', () =>
  withEnv(env, async () => {
    const fromRow = setup([userRow({ messages_opt_out: true })]);
    assert.deepEqual(await sendTemplate(fromRow.input(), fromRow.deps), { status: 'skipped', reason: 'category_off' });

    const fromCaller = setup();
    assert.deepEqual(
      await sendTemplate(
        fromCaller.input({ user: { id: U, email: FIXTURE_USER.email, messages_opt_out: true } }),
        fromCaller.deps
      ),
      { status: 'skipped', reason: 'category_off' }
    );
    assert.equal(fromRow.sent.length + fromCaller.sent.length, 0);
  }));

test('transactional mail ignores category switches and the one-click stop', () =>
  withEnv(env, async () => {
    const { sent, deps, input } = setup([userRow({ messages_opt_out: true, email_prefs: { lifecycle: false, transactional: false } })]);
    const result = await sendTemplate(
      input({ templateKey: 'tx_payment_failed', copy: transactionalCopy, enforceGap: true }),
      deps
    );
    assert.equal(result.status, 'sent');
    assert.deepEqual(sent[0].headers, {});
  }));

test('gap rule: an optional mail within 24 hours holds the next optional one back', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup([userRow()], [logRow({ sent_at: hoursAgo(5) })]);
    assert.deepEqual(await sendTemplate(input(), deps), { status: 'skipped', reason: 'min_gap' });
    assert.equal(sent.length, 0);
    // Held back before the claim, so the step is still available later.
    assert.equal(admin.tables.message_log.length, 1);
  }));

test('gap rule is only applied when asked for', () =>
  withEnv(env, async () => {
    const { deps, input } = setup([userRow()], [logRow({ sent_at: hoursAgo(5) })]);
    assert.equal((await sendTemplate(input({ enforceGap: false }), deps)).status, 'sent');
  }));

test('gap rule: transactional, older, failed and skipped rows do not count; rows with no category do', () =>
  withEnv(env, async () => {
    const notCounted = [
      logRow({ template: 'tx_trial_ending', category: 'transactional', sent_at: hoursAgo(1) }),
      logRow({ template: 'a', sent_at: hoursAgo(25) }),
      logRow({ template: 'b', status: 'failed', sent_at: null }),
      logRow({ template: 'c', status: 'skipped', sent_at: null }),
    ];
    const free = setup([userRow()], notCounted);
    assert.equal((await sendTemplate(free.input(), free.deps)).status, 'sent');

    const legacy = setup([userRow()], [logRow({ template: 'welcome_ads_connect', category: null, sent_at: hoursAgo(3) })]);
    assert.deepEqual(await sendTemplate(legacy.input(), legacy.deps), { status: 'skipped', reason: 'min_gap' });
  }));

test('gap rule never holds back transactional mail', () =>
  withEnv(env, async () => {
    const { deps, input } = setup([userRow()], [logRow({ sent_at: hoursAgo(1) })]);
    const result = await sendTemplate(input({ templateKey: 'tx_payment_failed', copy: transactionalCopy }), deps);
    assert.equal(result.status, 'sent');
  }));

test('gap rule: if the log cannot be read nothing is sent', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup();
    const realFrom = admin.from.bind(admin);
    (admin as any).from = (table: string) => {
      const query: any = realFrom(table);
      if (table === 'message_log') {
        query.then = (resolve: any) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
      }
      return query;
    };
    assert.deepEqual(await sendTemplate(input(), deps), { status: 'failed', reason: 'gap_lookup_failed' });
    assert.equal(sent.length, 0);
  }));

test('optional copy that is not approved is never sent, and the database is not touched', () =>
  withEnv(env, async () => {
    const touched: string[] = [];
    const deps: SendDeps = {
      supabase: { from: (t: string) => { touched.push(t); throw new Error('no db'); }, rpc: () => { touched.push('rpc'); throw new Error('no db'); } },
      emailConfigured: () => true,
      now: () => NOW,
      sendEmail: async () => { throw new Error('must not send'); },
    };
    const { input } = setup();
    assert.deepEqual(await sendTemplate(input({ copy: { ...lifecycleCopy, approved: false } }), deps), {
      status: 'skipped',
      reason: 'not_approved',
    });
    assert.deepEqual(touched, []);
  }));

test('transactional copy is sent whether or not approved is set', () =>
  withEnv(env, async () => {
    const { deps, input } = setup();
    const result = await sendTemplate(
      input({ templateKey: 'tx_payment_failed', copy: { ...transactionalCopy, approved: false }, enforceGap: false }),
      deps
    );
    assert.equal(result.status, 'sent');
  }));

test('not configured: nothing is read or written', () =>
  withEnv(env, async () => {
    const { admin, deps, input } = setup();
    assert.deepEqual(await sendTemplate(input(), { ...deps, emailConfigured: () => false }), { status: 'not_configured' });
    assert.equal(admin.tables.message_log.length, 0);
  }));

test('prefs passed in deps are used and the users table is not read', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup([]);
    const reads: string[] = [];
    const realFrom = admin.from.bind(admin);
    (admin as any).from = (t: string) => { reads.push(t); return realFrom(t); };

    const off = await sendTemplate(input(), { ...deps, prefs: { email_prefs: { lifecycle: false } } });
    assert.deepEqual(off, { status: 'skipped', reason: 'category_off' });
    const suppressed = await sendTemplate(input(), { ...deps, prefs: { email_suppressed_at: '2026-10-01T00:00:00Z' } });
    assert.deepEqual(suppressed, { status: 'skipped', reason: 'suppressed' });
    const ok = await sendTemplate(input(), { ...deps, prefs: { email_prefs: {} } });
    assert.equal(ok.status, 'sent');
    assert.equal(reads.includes('users'), false);
    assert.equal(sent.length, 1);
  }));

test('without prefs in deps the user is read once; a missing user row fails closed', () =>
  withEnv(env, async () => {
    const { admin, deps, input } = setup([]);
    const reads: string[] = [];
    const realFrom = admin.from.bind(admin);
    (admin as any).from = (t: string) => { reads.push(t); return realFrom(t); };
    assert.deepEqual(await sendTemplate(input(), deps), { status: 'failed', reason: 'prefs_user_not_found' });
    assert.deepEqual(reads, ['users']);
  }));

test('provider refusal is logged as failed with its reason and can be retried', () =>
  withEnv(env, async () => {
    const { admin, deps, input } = setup();
    const failing: SendDeps = { ...deps, sendEmail: async () => ({ sent: false, reason: 'email_not_configured' as const }) };
    assert.deepEqual(await sendTemplate(input(), failing), { status: 'failed', reason: 'email_not_configured' });
    assert.equal(admin.tables.message_log[0].status, 'failed');
    assert.equal(admin.tables.message_log[0].category, 'lifecycle');
    // The retry is allowed (attempts < 3) and succeeds.
    assert.equal((await sendTemplate(input(), deps)).status, 'sent');
    assert.equal(admin.tables.message_log[0].status, 'sent');
    assert.equal(admin.tables.message_log[0].attempts, 2);
  }));

test('a provider that throws is logged as failed, not left sending', () =>
  withEnv(env, async () => {
    const { admin, deps, input } = setup();
    const throwing: SendDeps = { ...deps, sendEmail: async () => { throw new Error('Resend returned 422'); } };
    const result = await sendTemplate(input(), throwing);
    assert.equal(result.status, 'failed');
    assert.equal(admin.tables.message_log[0].status, 'failed');
    assert.match(String(admin.tables.message_log[0].reason), /422/);
  }));

test('a copy with nothing to say for this user is logged as skipped no_content and never retried', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup();
    const empty: EmailCopy = { ...lifecycleCopy, build: () => null };
    assert.deepEqual(await sendTemplate(input({ copy: empty }), deps), { status: 'skipped', reason: 'no_content' });
    assert.equal(admin.tables.message_log[0].status, 'skipped');
    assert.equal(admin.tables.message_log[0].reason, 'no_content');
    assert.equal(admin.tables.message_log[0].category, 'lifecycle');
    assert.deepEqual(await sendTemplate(input({ copy: empty }), deps), { status: 'duplicate' });
    assert.equal(sent.length, 0);
  }));

test('without a signing key an optional mail fails closed before anything is claimed', () =>
  withEnv({ ...env, UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, async () => {
    const { admin, sent, deps, input } = setup();
    assert.deepEqual(await sendTemplate(input(), deps), { status: 'failed', reason: 'unsubscribe_secret_missing' });
    assert.equal(admin.tables.message_log.length, 0);
    assert.equal(sent.length, 0);
  }));

test('an invalid template key is refused', () =>
  withEnv(env, async () => {
    const { deps, input } = setup();
    assert.deepEqual(await sendTemplate(input({ templateKey: 'bad key/x' }), deps), { status: 'failed', reason: 'bad_template_key' });
  }));

test('the welcome copy records the welcome_email_sent funnel event once', () =>
  withEnv(env, async () => {
    const { admin, deps, input } = setup();
    const welcome: EmailCopy = { ...lifecycleCopy, key: 'welcome_ads_connect', category: 'onboarding' };
    const result = await sendTemplate(input({ templateKey: 'welcome_ads_connect', copy: welcome, enforceGap: false }), deps);
    assert.equal(result.status, 'sent');
    assert.equal(admin.tables.user_events.length, 1);
    assert.equal(admin.tables.user_events[0].event, 'welcome_email_sent');
    assert.equal(admin.tables.user_events[0].user_id, U);
    // other templates leave the funnel events alone
    const other = setup();
    await sendTemplate(other.input(), other.deps);
    assert.equal(other.admin.tables.user_events.length, 0);
  }));

test('before the lifecycle migration the log update is repeated without the new columns, so the row never stays "sending"', () =>
  withEnv(env, async () => {
    const { admin, sent, deps, input } = setup();
    const realFrom = admin.from.bind(admin);
    (admin as any).from = (table: string) => {
      const query: any = realFrom(table);
      if (table !== 'message_log') return query;
      const realUpdate = query.update.bind(query);
      query.update = (patch: Record<string, unknown>) => {
        if ('category' in patch) {
          const chain: any = { eq: () => chain, then: (resolve: any) => Promise.resolve({ data: null, error: { code: '42703', message: 'column "category" of relation "message_log" does not exist' } }).then(resolve) };
          return chain;
        }
        return realUpdate(patch);
      };
      return query;
    };
    const result = await sendTemplate(input({ enforceGap: false }), deps);
    assert.equal(result.status, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(admin.tables.message_log[0].status, 'sent');
    assert.equal(admin.tables.message_log[0].provider_id, 're_1');
    assert.equal('category' in admin.tables.message_log[0], false);
  }));
