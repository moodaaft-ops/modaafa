import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import type { BuiltEmail, EmailFacts } from '../lib/lifecycle/types';
import { createStripeWebhookHandler, type StripeWebhookDependencies } from '../lib/billing/stripe-webhook-handler';
import { FOOTER_STOP_LABEL } from '../lib/messaging/render';
import { paymentFailedEmail, sendEmail, subscriptionWelcomeEmail, trialEndingEmail } from '../lib/notifications/email';
import { FIXTURE_USER } from './support/email-fixtures';
import { withEnv } from './support/with-env';

const env = {
  UNSUBSCRIBE_SECRET: 'test-secret-value',
  NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com',
};

const recipient = { id: FIXTURE_USER.id, email: FIXTURE_USER.email, name: FIXTURE_USER.name };

test('the three billing builders return a finished brand-shell mail, ready to send as given', () =>
  withEnv(env, () => {
    const mails = {
      tx_subscription_welcome: subscriptionWelcomeEmail(recipient),
      tx_trial_ending: trialEndingEmail('2026-10-17T10:00:00Z', recipient),
      tx_payment_failed: paymentFailedEmail(recipient),
    };
    for (const [key, mail] of Object.entries(mails)) {
      assert.ok(mail, key);
      assert.equal(mail.rawHtml, true, key);
      assert.match(mail.html, /^<!doctype html>/i, key);
      assert.match(mail.html, /dir="rtl"/, key);
      assert.match(mail.html, /#F4F2EC/i, key);
      assert.ok(mail.text.length > 10, key);
      assert.ok(mail.subject.length > 0, key);
      assert.deepEqual(
        mail.tags,
        [
          { name: 'template', value: key },
          { name: 'category', value: 'transactional' },
        ],
        key
      );
      // Transactional mail has no stop link, no one-click header and no stop wording.
      assert.deepEqual(mail.headers, {}, key);
      assert.doesNotMatch(mail.html, /opt-out/, key);
      assert.doesNotMatch(mail.html, new RegExp(FOOTER_STOP_LABEL), key);
      assert.doesNotMatch(mail.text, /opt-out/, key);
      // The preferences page is still linked.
      assert.match(mail.html, /\/email-preferences\?u=/, key);
      // The button goes through the click tracker.
      assert.match(mail.html, /https:\/\/ai\.modaafa\.com\/m\/c\?/, key);
    }
  }));

test('billing mail ignores the approved flag of its copy (the stubs are unapproved)', () =>
  withEnv(env, () => {
    for (const key of ['tx_subscription_welcome', 'tx_trial_ending', 'tx_payment_failed'] as const) {
      assert.equal(EMAIL_COPY[key].category, 'transactional');
    }
    assert.ok(subscriptionWelcomeEmail(recipient));
    assert.ok(paymentFailedEmail(recipient));
    assert.ok(trialEndingEmail(null, recipient));
  }));

test('without a signing key a billing mail still goes out, with a plain UTM link instead of a tracked one', () =>
  withEnv({ ...env, UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
    const mail = paymentFailedEmail(recipient);
    assert.ok(mail);
    assert.doesNotMatch(mail.html, /\/m\/c\?/);
    assert.match(mail.html, /https:\/\/ai\.modaafa\.com\/home\?utm_source=email/);
  }));

test('the recipient name becomes the greeting and the date of the trial reaches the copy', () =>
  withEnv(env, () => {
    const copy = EMAIL_COPY.tx_trial_ending;
    const original = copy.build;
    const seen: EmailFacts[] = [];
    copy.build = (facts): BuiltEmail | null => {
      seen.push(facts);
      return original(facts);
    };
    try {
      const mail = trialEndingEmail('2026-10-17T10:00:00Z', recipient);
      assert.ok(mail);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].firstName, 'سارة');
      assert.deepEqual(seen[0].billing, { planName: null, trialEndsAt: '2026-10-17T10:00:00Z' });
      assert.match(mail.text, /^هلا سارة،/);

      trialEndingEmail(undefined, { ...recipient, name: null });
      assert.equal(seen[1].firstName, null);
      assert.deepEqual(seen[1].billing, { planName: null, trialEndsAt: null });
      assert.match(trialEndingEmail(undefined, { ...recipient, name: null })!.text, /^هلا،/);
    } finally {
      copy.build = original;
    }
  }));

test('a copy that builds nothing gives null instead of an empty mail', () => {
  const copy = EMAIL_COPY.tx_payment_failed;
  const original = copy.build;
  copy.build = () => null;
  try {
    assert.equal(paymentFailedEmail(recipient), null);
  } finally {
    copy.build = original;
  }
});

type Captured = { url: string; headers: Record<string, string>; body: Record<string, any> };

async function captureResend(fn: () => Promise<unknown>) {
  const realFetch = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), headers: init.headers, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: 're_test_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

const resendEnv = { RESEND_API_KEY: 're_test_key', RESEND_FROM_EMAIL: 'مُضاعِف <hello@modaafa.com>' };

test('sendEmail with rawHtml sends the document untouched and passes text, headers and cleaned tags', () =>
  withEnv(resendEnv, async () => {
    const calls = await captureResend(async () => {
      const result = await sendEmail({
        to: 'sara@example.com',
        subject: 'موضوع',
        html: '<!doctype html><html><body>done</body></html>',
        text: 'نص عادي',
        rawHtml: true,
        headers: { 'List-Unsubscribe': '<https://ai.modaafa.com/x>' },
        tags: [
          { name: 'template', value: 'welcome ads/connect' },
          { name: 'فئة', value: 'تجربة' },
        ],
        idempotencyKey: 'key-1',
      });
      assert.deepEqual(result, { sent: true, id: 're_test_1' });
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, 'https://api.resend.com/emails');
    assert.equal(call.headers['Idempotency-Key'], 'key-1');
    assert.equal(call.body.html, '<!doctype html><html><body>done</body></html>');
    assert.equal(call.body.text, 'نص عادي');
    assert.deepEqual(call.body.to, ['sara@example.com']);
    assert.deepEqual(call.body.headers, { 'List-Unsubscribe': '<https://ai.modaafa.com/x>' });
    for (const tag of call.body.tags) {
      assert.match(tag.name, /^[A-Za-z0-9_-]+$/);
      assert.match(tag.value, /^[A-Za-z0-9_-]+$/);
    }
    assert.deepEqual(call.body.tags[0], { name: 'template', value: 'welcome_ads_connect' });
  }));

test('sendEmail without rawHtml still wraps in the operational shell and leaves out empty extras', () =>
  withEnv(resendEnv, async () => {
    const calls = await captureResend(async () => {
      await sendEmail({ to: 'ops@example.com', subject: 'تنبيه', html: '<p>مرحبا</p>', headers: {}, tags: [] });
    });
    const [call] = calls;
    assert.match(call.body.html, /^<div dir="rtl"/);
    assert.match(call.body.html, /<p>مرحبا<\/p>/);
    assert.equal('text' in call.body, false);
    assert.equal('tags' in call.body, false);
    assert.equal('headers' in call.body, false);
    assert.equal('Idempotency-Key' in call.headers, false);
  }));

test('sendEmail reports not configured instead of calling Resend', () =>
  withEnv({ RESEND_API_KEY: undefined, RESEND_FROM_EMAIL: undefined }, async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const calls = await captureResend(async () => {
        assert.deepEqual(await sendEmail({ to: 'a@b.co', subject: 's', html: 'h' }), { sent: false, reason: 'email_not_configured' });
      });
      assert.equal(calls.length, 0);
    } finally {
      console.warn = warn;
    }
  }));

test('sendEmail throws on a Resend error so the caller can log it', () =>
  withEnv(resendEnv, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"message":"bad"}', { status: 422 })) as typeof fetch;
    try {
      await assert.rejects(() => sendEmail({ to: 'a@b.co', subject: 's', html: 'h' }), /Resend returned 422/);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

// --- the Stripe handler -------------------------------------------------------------------------

const CREATED_AT = Math.floor(new Date('2026-10-14T12:00:00.000Z').getTime() / 1000);

function stripeEvent(type: Stripe.Event.Type, object: object, id: string): Stripe.Event {
  return {
    id,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: CREATED_AT,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as Stripe.Event;
}

function trialSubscription() {
  return {
    id: 'sub_trial',
    object: 'subscription',
    status: 'trialing',
    customer: 'cus_test',
    metadata: { userId: 'user-1', plan: 'starter', period: 'monthly' },
    items: { data: [] },
    cancel_at_period_end: false,
    trial_end: CREATED_AT + 3 * 86_400,
  };
}

/** A users/subscriptions stand-in; `failFirstUsersSelect` mimics a database without the lifecycle columns. */
function database(user: Record<string, unknown> | null, options: { failFirstUsersSelect?: boolean } = {}) {
  const selects: string[] = [];
  return {
    selects,
    client: {
      from(table: string) {
        let columns = '';
        const chain: any = {
          select: (value: string) => {
            columns = value;
            if (table === 'users') selects.push(value);
            return chain;
          },
          eq: () => chain,
          maybeSingle: async () => {
            if (table === 'subscriptions') return { data: { user_id: 'user-1' }, error: null };
            if (options.failFirstUsersSelect && columns.includes('email_suppressed_at')) {
              return { data: null, error: { message: 'column users.email_suppressed_at does not exist', code: '42703' } };
            }
            return { data: user, error: null };
          },
        };
        return chain;
      },
    },
  };
}

function handler(db: ReturnType<typeof database>, sent: Array<Record<string, any>>) {
  return createStripeWebhookHandler({
    constructWebhookEvent: () => stripeEvent('customer.subscription.trial_will_end', { id: 'sub_trial', trial_end: CREATED_AT + 3 * 86_400 }, 'evt_tx'),
    createAdminClient: () => db.client as any,
    claimStripeWebhookEvent: async () => 'claimed',
    retrieveStripeSubscription: async () => trialSubscription() as any,
    completeStripeWebhookEvent: async () => undefined,
    failStripeWebhookEvent: async () => undefined,
    sendOpsAlert: async () => ({ sent: true, id: 'ops' }),
    sendEmail: (async (message: Record<string, any>) => {
      sent.push(message);
      return { sent: true };
    }) as any,
  } as Partial<StripeWebhookDependencies>);
}

function webhookRequest() {
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': 'stubbed-valid-signature' },
    body: '{}',
  });
}

test('Stripe trial-ending mail goes out in the brand shell with text and tags, greeting the customer by name', () =>
  withEnv(env, async () => {
    const sent: Array<Record<string, any>> = [];
    const db = database({ email: 'customer@example.com', name: 'نورة القحطاني', email_suppressed_at: null });
    const response = await handler(db, sent)(webhookRequest());
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    const [mail] = sent;
    assert.equal(mail.to, 'customer@example.com');
    assert.equal(mail.rawHtml, true);
    assert.match(mail.html, /dir="rtl"/);
    assert.match(mail.text, /^هلا نورة،/);
    assert.deepEqual(mail.tags, [
      { name: 'template', value: 'tx_trial_ending' },
      { name: 'category', value: 'transactional' },
    ]);
  }));

test('Stripe billing mail is not sent to an address that bounced or complained', () =>
  withEnv(env, async () => {
    const sent: Array<Record<string, any>> = [];
    const db = database({ email: 'customer@example.com', name: 'نورة', email_suppressed_at: '2026-10-01T00:00:00Z' });
    const response = await handler(db, sent)(webhookRequest());
    assert.equal(response.status, 200, 'the event itself is still processed');
    assert.deepEqual(sent, []);
  }));

test('Stripe billing mail still goes out when the lifecycle migration has not run (no suppression column)', () =>
  withEnv(env, async () => {
    const sent: Array<Record<string, any>> = [];
    const db = database({ email: 'customer@example.com', name: 'نورة' }, { failFirstUsersSelect: true });
    const log = console.error;
    console.error = () => {};
    try {
      const response = await handler(db, sent)(webhookRequest());
      assert.equal(response.status, 200);
    } finally {
      console.error = log;
    }
    assert.equal(sent.length, 1);
    assert.deepEqual(db.selects, ['email, name, email_suppressed_at', 'email, name']);
  }));

test('Stripe billing mail with no address on file, or a failing send, never fails the webhook', () =>
  withEnv(env, async () => {
    const none: Array<Record<string, any>> = [];
    assert.equal((await handler(database({ email: null, name: 'x' }), none)(webhookRequest())).status, 200);
    assert.deepEqual(none, []);

    const log = console.error;
    console.error = () => {};
    try {
      const db = database({ email: 'customer@example.com', name: 'x' });
      const failing = createStripeWebhookHandler({
        constructWebhookEvent: () => stripeEvent('customer.subscription.trial_will_end', { id: 'sub_trial', trial_end: CREATED_AT + 3 * 86_400 }, 'evt_tx2'),
        createAdminClient: () => db.client as any,
        claimStripeWebhookEvent: async () => 'claimed',
        retrieveStripeSubscription: async () => trialSubscription() as any,
        completeStripeWebhookEvent: async () => undefined,
        failStripeWebhookEvent: async () => undefined,
        sendOpsAlert: async () => ({ sent: true, id: 'ops' }),
        sendEmail: (async () => {
          throw new Error('resend down');
        }) as any,
      } as Partial<StripeWebhookDependencies>);
      assert.equal((await failing(webhookRequest())).status, 200);
    } finally {
      console.error = log;
    }
  }));
