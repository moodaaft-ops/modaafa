import assert from 'node:assert/strict';
import test from 'node:test';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { sendWelcomeAfterRegistration, sendWelcomeInBackground, type WelcomeOptions } from '../lib/lifecycle/welcome';
import type { SendTemplateFn, SendTemplateInput } from '../lib/lifecycle/run';
import type { EmailCopy } from '../lib/lifecycle/types';
import { createFakeAdmin } from './support/fake-admin';
import { ACTIVATED_AT, riyadh } from './support/lifecycle';

const NOW = riyadh('2026-10-14T12:00');
const approved: EmailCopy = { ...EMAIL_COPY.welcome_ads_connect, approved: true };

const person = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'u1@example.com',
  name: 'سلمان العتيبي',
  messages_opt_out: false,
  ...overrides,
});

function setup(users: Array<Record<string, unknown>> = [person()], answer: Awaited<ReturnType<SendTemplateFn>> = { status: 'sent', providerId: 'mail-1' }) {
  const admin = createFakeAdmin({ users });
  admin.setClock(() => NOW);
  const calls: Array<{ input: SendTemplateInput; deps: Record<string, any> }> = [];
  const sendTemplate: SendTemplateFn = async (input, deps) => {
    calls.push({ input, deps: deps as Record<string, any> });
    return answer;
  };
  const options: WelcomeOptions = {
    admin,
    now: NOW,
    env: { EMAIL_LIFECYCLE_ENABLED: 'true' },
    activatedAt: ACTIVATED_AT,
    copy: approved,
    sendTemplate,
  };
  return { admin, calls, options };
}

const welcomeEvents = (admin: ReturnType<typeof createFakeAdmin>) => admin.tables.user_events!.filter((e) => e.event === 'welcome_email_sent');

// ---------------------------------------------------------------------------
// Gates: all three must be open
// ---------------------------------------------------------------------------

test('welcome: nothing happens unless EMAIL_LIFECYCLE_ENABLED is exactly "true"', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    const { calls, options } = setup();
    assert.equal(await sendWelcomeAfterRegistration('u1', { ...options, env: { EMAIL_LIFECYCLE_ENABLED: value } }), 'disabled', String(value));
    assert.deepEqual(calls, []);
  }
});

test('welcome: no activation moment, an unreadable one, or one in the future means no mail', async () => {
  for (const activatedAt of [null, 'soon', new Date(NOW.getTime() + 1000).toISOString()]) {
    const { calls, options } = setup();
    assert.equal(await sendWelcomeAfterRegistration('u1', { ...options, activatedAt }), 'not_activated', String(activatedAt));
    assert.deepEqual(calls, []);
  }
});

test('welcome: activation exactly now is open', async () => {
  const { calls, options } = setup();
  assert.equal(await sendWelcomeAfterRegistration('u1', { ...options, activatedAt: NOW.toISOString() }), 'sent');
  assert.equal(calls.length, 1);
});

test('welcome: unapproved copy is never sent (the shipped state)', async () => {
  const { calls, options } = setup();
  assert.equal(await sendWelcomeAfterRegistration('u1', { ...options, copy: { ...EMAIL_COPY.welcome_ads_connect, approved: false } }), 'not_approved');
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('welcome: sends the approved copy to the new user without the gap rule and records the event', async () => {
  const { admin, calls, options } = setup();
  assert.equal(await sendWelcomeAfterRegistration('u1', options), 'sent');

  assert.equal(calls.length, 1);
  const { input, deps } = calls[0]!;
  assert.equal(input.templateKey, 'welcome_ads_connect');
  assert.equal(input.copy.key, 'welcome_ads_connect');
  assert.equal(input.enforceGap, false, 'the welcome mail is the first one; the gap rule would only get in its way');
  assert.deepEqual(input.user, { id: 'u1', email: 'u1@example.com', name: 'سلمان العتيبي', messages_opt_out: false });
  assert.equal(input.facts.firstName, 'سلمان');
  assert.equal(input.facts.plan, null);
  assert.equal(input.facts.trial, null);
  assert.equal(deps.supabase, admin);
  assert.equal(deps.now().getTime(), NOW.getTime());

  const events = welcomeEvents(admin);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.user_id, 'u1');
  assert.equal(events[0]!.created_at, NOW.toISOString());
});

test('welcome: the event is recorded once even if the sweep and the immediate send both succeed', async () => {
  const { admin, options } = setup();
  await sendWelcomeAfterRegistration('u1', options);
  await sendWelcomeAfterRegistration('u1', options);
  assert.equal(welcomeEvents(admin).length, 1);
});

test('welcome: sendTemplateDeps are passed through and the caller cannot lose the run clock', async () => {
  const { calls, options } = setup();
  await sendWelcomeAfterRegistration('u1', { ...options, sendTemplateDeps: { resend: 'fake' } });
  assert.equal(calls[0]!.deps.resend, 'fake');
  assert.equal(typeof calls[0]!.deps.now, 'function');
});

test('welcome: the opt-out flag is handed to the sender, which decides', async () => {
  const { calls, options } = setup([person({ messages_opt_out: true })]);
  await sendWelcomeAfterRegistration('u1', options);
  assert.equal(calls[0]!.input.user.messages_opt_out, true);
});

test('welcome: a first name that is missing, blank or absurdly long becomes null', async () => {
  const cases: Array<[string | null, string | null]> = [
    [null, null],
    ['   ', null],
    ['  أيمن   الأحمد ', 'أيمن'],
    ['x'.repeat(41), null],
    ['x'.repeat(40), 'x'.repeat(40)],
  ];
  for (const [name, expected] of cases) {
    const { calls, options } = setup([person({ name })]);
    await sendWelcomeAfterRegistration('u1', options);
    assert.equal(calls[0]!.input.facts.firstName, expected, String(name));
  }
});

// ---------------------------------------------------------------------------
// Not sent
// ---------------------------------------------------------------------------

test('welcome: an unknown user or one without an address is not mailed', async () => {
  const unknown = setup([]);
  assert.equal(await sendWelcomeAfterRegistration('u1', unknown.options), 'user_not_found');
  const noEmail = setup([person({ email: null })]);
  assert.equal(await sendWelcomeAfterRegistration('u1', noEmail.options), 'no_email');
  assert.deepEqual([...unknown.calls, ...noEmail.calls], []);
});

test('welcome: results other than sent are reported and record no event', async () => {
  const answers: Array<[Awaited<ReturnType<SendTemplateFn>>, string]> = [
    [{ status: 'duplicate' }, 'duplicate'],
    [{ status: 'skipped', reason: 'opted_out' }, 'skipped:opted_out'],
    [{ status: 'failed', reason: 'resend_500' }, 'failed:resend_500'],
    [{ status: 'not_configured' }, 'not_configured'],
  ];
  for (const [answer, expected] of answers) {
    const { admin, options } = setup([person()], answer);
    assert.equal(await sendWelcomeAfterRegistration('u1', options), expected);
    assert.deepEqual(welcomeEvents(admin), [], expected);
  }
});

test('welcome: never throws, whatever breaks', async () => {
  const { options } = setup();
  const throwing: SendTemplateFn = async () => {
    throw new Error('socket hang up');
  };
  assert.equal(await sendWelcomeAfterRegistration('u1', { ...options, sendTemplate: throwing }), 'failed:exception');

  const brokenAdmin = {
    from() {
      throw new Error('db down');
    },
  };
  assert.equal(await sendWelcomeAfterRegistration('u1', { ...options, admin: brokenAdmin }), 'failed:exception');
});

test('welcome: a broken event write does not turn a sent mail into a failure', async () => {
  const { admin, options } = setup();
  const rpc = admin.rpc.bind(admin);
  admin.rpc = async (name: string, args: any) => (name === 'record_user_event' ? { data: null, error: { code: 'XX000' } } : rpc(name, args));
  assert.equal(await sendWelcomeAfterRegistration('u1', options), 'sent');
});

// ---------------------------------------------------------------------------
// Fire and forget
// ---------------------------------------------------------------------------

test('welcome in the background: outside a request it just runs, and with the switch off it does nothing and does not throw', async () => {
  const previous = process.env.EMAIL_LIFECYCLE_ENABLED;
  delete process.env.EMAIL_LIFECYCLE_ENABLED;
  try {
    assert.doesNotThrow(() => sendWelcomeInBackground('u1'));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (previous !== undefined) process.env.EMAIL_LIFECYCLE_ENABLED = previous;
  }
});
