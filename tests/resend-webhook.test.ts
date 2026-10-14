import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { SVIX_TOLERANCE_SECONDS, verifySvixSignature } from '../lib/messaging/svix';
import { applyResendEvent } from '../lib/messaging/webhook-events';
import { POST as webhookPost } from '../app/api/webhooks/resend/route';
import { createFakeAdmin } from './support/fake-admin';
import { FAKE_SUPABASE_ENV, installFakePostgrest } from './support/fake-postgrest';
import { withEnv } from './support/with-env';

const KEY = Buffer.from('resend-webhook-signing-key-0123456789', 'utf8');
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW_MS = Date.parse('2026-10-14T10:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const U = '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33';

function sign(id: string, timestamp: number | string, body: string, key: Buffer = KEY) {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

const BODY = '{"type":"email.delivered","data":{"email_id":"re_1"}}';

test('svix: a correctly signed request verifies', () => {
  const sig = sign('msg_1', NOW_S, BODY);
  assert.deepEqual(
    verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: String(NOW_S), signature: sig, body: BODY, nowMs: NOW_MS }),
    { ok: true }
  );
});

test('svix: the secret works with or without the whsec_ prefix', () => {
  const sig = sign('msg_1', NOW_S, BODY);
  const bare = KEY.toString('base64');
  assert.equal(verifySvixSignature({ secret: bare, id: 'msg_1', timestamp: String(NOW_S), signature: sig, body: BODY, nowMs: NOW_MS }).ok, true);
});

test('svix: any one of several space separated signatures may match (secret rotation)', () => {
  const old = sign('msg_1', NOW_S, BODY, Buffer.from('an-older-key'));
  const current = sign('msg_1', NOW_S, BODY);
  for (const header of [`${old} ${current}`, `${current} ${old}`, `v2,abc ${current}`, `${current}`]) {
    assert.equal(
      verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: String(NOW_S), signature: header, body: BODY, nowMs: NOW_MS }).ok,
      true,
      header
    );
  }
});

test('svix: tampered body, id, timestamp or signature are refused', () => {
  const sig = sign('msg_1', NOW_S, BODY);
  const base = { secret: SECRET, id: 'msg_1', timestamp: String(NOW_S), signature: sig, body: BODY, nowMs: NOW_MS };
  assert.deepEqual(verifySvixSignature({ ...base, body: `${BODY} ` }), { ok: false, reason: 'no_match' });
  assert.deepEqual(verifySvixSignature({ ...base, id: 'msg_2' }), { ok: false, reason: 'no_match' });
  assert.deepEqual(verifySvixSignature({ ...base, timestamp: String(NOW_S + 1) }), { ok: false, reason: 'no_match' });
  assert.deepEqual(verifySvixSignature({ ...base, signature: sig.slice(0, -4) }), { ok: false, reason: 'no_match' });
  assert.deepEqual(verifySvixSignature({ ...base, signature: 'v1,' }), { ok: false, reason: 'no_match' });
  assert.deepEqual(verifySvixSignature({ ...base, signature: 'garbage' }), { ok: false, reason: 'no_match' });
  assert.deepEqual(verifySvixSignature({ ...base, secret: `whsec_${Buffer.from('another-key').toString('base64')}` }), { ok: false, reason: 'no_match' });
  // Only v1 counts.
  assert.deepEqual(verifySvixSignature({ ...base, signature: sig.replace('v1,', 'v2,') }), { ok: false, reason: 'no_match' });
});

test('svix: missing headers and a bad timestamp or secret', () => {
  const sig = sign('msg_1', NOW_S, BODY);
  const base = { secret: SECRET, id: 'msg_1', timestamp: String(NOW_S), signature: sig, body: BODY, nowMs: NOW_MS };
  assert.deepEqual(verifySvixSignature({ ...base, id: null }), { ok: false, reason: 'missing_headers' });
  assert.deepEqual(verifySvixSignature({ ...base, timestamp: undefined }), { ok: false, reason: 'missing_headers' });
  assert.deepEqual(verifySvixSignature({ ...base, signature: '' }), { ok: false, reason: 'missing_headers' });
  assert.deepEqual(verifySvixSignature({ ...base, timestamp: 'abc' }), { ok: false, reason: 'bad_timestamp' });
  assert.deepEqual(verifySvixSignature({ ...base, timestamp: '-5' }), { ok: false, reason: 'bad_timestamp' });
  assert.deepEqual(verifySvixSignature({ ...base, secret: 'whsec_' }), { ok: false, reason: 'bad_secret' });
});

test('svix: five minutes of clock skew either way is accepted, more is not', () => {
  assert.equal(SVIX_TOLERANCE_SECONDS, 300);
  const at = (offset: number) => {
    const ts = NOW_S + offset;
    return verifySvixSignature({ secret: SECRET, id: 'm', timestamp: String(ts), signature: sign('m', ts, BODY), body: BODY, nowMs: NOW_MS });
  };
  assert.equal(at(0).ok, true);
  assert.equal(at(-299).ok, true);
  assert.equal(at(299).ok, true);
  assert.equal(at(-300).ok, true);
  assert.deepEqual(at(-301), { ok: false, reason: 'timestamp_out_of_range' });
  assert.deepEqual(at(301), { ok: false, reason: 'timestamp_out_of_range' });
  assert.deepEqual(at(-86400), { ok: false, reason: 'timestamp_out_of_range' });
});

function seed() {
  return createFakeAdmin({
    users: [
      { id: U, email: 'sara@example.com', email_prefs: {}, messages_opt_out: false, email_suppressed_at: null, email_suppressed_reason: null },
      { id: 'other', email: 'other@example.com', email_prefs: {}, email_suppressed_at: null },
    ],
    message_log: [
      { id: 'log-1', user_id: U, channel: 'email', template: 'registered_1d', status: 'sent', provider_id: 're_1', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, click_count: 0 },
    ],
  });
}

const event = (type: string, data: Record<string, unknown> = {}, created_at = '2026-10-14T10:00:00.000Z') => ({
  type,
  created_at,
  data: { email_id: 're_1', to: ['sara@example.com'], ...data },
});

test('delivered, opened and clicked stamp their column the first time only', async () => {
  const admin = seed();
  for (const [type, column] of [['email.delivered', 'delivered_at'], ['email.opened', 'opened_at'], ['email.clicked', 'clicked_at']] as const) {
    const first = await applyResendEvent(admin, event(type, {}, '2026-10-14T10:00:00.000Z'));
    assert.equal(first.status, 'applied', type);
    assert.equal(admin.tables.message_log[0][column], '2026-10-14T10:00:00.000Z');
    const again = await applyResendEvent(admin, event(type, {}, '2026-10-14T12:00:00.000Z'));
    assert.deepEqual(again, { status: 'duplicate' }, type);
    assert.equal(admin.tables.message_log[0][column], '2026-10-14T10:00:00.000Z', 'first time is kept');
  }
  // Click counting belongs to the /m/c redirect, not the webhook.
  assert.equal(admin.tables.message_log[0].click_count, 0);
  assert.equal(admin.tables.users[0].email_suppressed_at, null);
});

test('a hard bounce stamps bounced_at and suppresses the address; replays change nothing', async () => {
  const admin = seed();
  const hard = event('email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: 'no such user' } });
  assert.equal((await applyResendEvent(admin, hard)).status, 'applied');
  assert.equal(admin.tables.message_log[0].bounced_at, '2026-10-14T10:00:00.000Z');
  assert.equal(admin.tables.users[0].email_suppressed_at, '2026-10-14T10:00:00.000Z');
  assert.equal(admin.tables.users[0].email_suppressed_reason, 'hard_bounce');
  assert.deepEqual(admin.tables.users[0].email_prefs, {}, 'a bounce does not touch the category choices');
  assert.deepEqual(await applyResendEvent(admin, { ...hard, created_at: '2026-10-15T00:00:00.000Z' }), { status: 'duplicate' });
  assert.equal(admin.tables.users[0].email_suppressed_at, '2026-10-14T10:00:00.000Z');
});

test('a bounce without a type is treated as hard; a soft bounce is recorded but does not suppress', async () => {
  const noType = seed();
  await applyResendEvent(noType, event('email.bounced'));
  assert.equal(noType.tables.users[0].email_suppressed_reason, 'hard_bounce');

  for (const type of ['Transient', 'Undetermined', 'transient']) {
    const soft = seed();
    const outcome = await applyResendEvent(soft, event('email.bounced', { bounce: { type } }));
    assert.equal(outcome.status, 'applied', type);
    assert.equal(soft.tables.message_log[0].bounced_at, '2026-10-14T10:00:00.000Z');
    assert.equal(soft.tables.users[0].email_suppressed_at, null, type);
  }
});

test('a complaint suppresses the address and turns every optional category off', async () => {
  const admin = seed();
  admin.tables.users[0].email_prefs = { onboarding: true, lifecycle: true };
  const outcome = await applyResendEvent(admin, event('email.complained'));
  assert.equal(outcome.status, 'applied');
  const user = admin.tables.users[0];
  assert.equal(admin.tables.message_log[0].complained_at, '2026-10-14T10:00:00.000Z');
  assert.equal(user.email_suppressed_at, '2026-10-14T10:00:00.000Z');
  assert.equal(user.email_suppressed_reason, 'complaint');
  assert.deepEqual(user.email_prefs, { onboarding: true, lifecycle: false, weekly_report: false, product_news: false });
  assert.deepEqual(await applyResendEvent(admin, event('email.complained')), { status: 'duplicate' });
});

test('an unknown email id is ignored, not an error', async () => {
  const admin = seed();
  assert.deepEqual(await applyResendEvent(admin, event('email.delivered', { email_id: 're_unknown' })), {
    status: 'ignored',
    reason: 'unknown_email_id',
  });
  assert.deepEqual(await applyResendEvent(admin, { type: 'email.delivered', data: {} }), { status: 'ignored', reason: 'no_email_id' });
  assert.deepEqual(await applyResendEvent(admin, { type: 'email.delivered' }), { status: 'ignored', reason: 'no_email_id' });
  assert.deepEqual(await applyResendEvent(admin, { type: 'email.sent', data: { email_id: 're_1' } }), { status: 'ignored', reason: 'event_type' });
  assert.deepEqual(await applyResendEvent(admin, { data: { email_id: 're_1' } }), { status: 'ignored', reason: 'event_type' });
  assert.equal(admin.tables.message_log[0].delivered_at, null);
});

test('a bounce or complaint on mail that is not logged (billing mail) still suppresses the recipient', async () => {
  const bounced = seed();
  const outcome = await applyResendEvent(bounced, event('email.bounced', { email_id: 're_billing', to: ['Sara@Example.com'], bounce: { type: 'Permanent' } }));
  assert.deepEqual(outcome, { status: 'applied', detail: 'suppressed_by_address' });
  assert.equal(bounced.tables.users[0].email_suppressed_reason, 'hard_bounce');

  const complained = seed();
  await applyResendEvent(complained, event('email.complained', { email_id: 're_billing', to: ['sara@example.com'] }));
  assert.equal(complained.tables.users[0].email_suppressed_reason, 'complaint');
  assert.deepEqual(complained.tables.users[0].email_prefs, { lifecycle: false, weekly_report: false, product_news: false });

  const nobody = seed();
  assert.deepEqual(
    await applyResendEvent(nobody, event('email.bounced', { email_id: 're_x', to: ['stranger@example.com'], bounce: { type: 'Permanent' } })),
    { status: 'ignored', reason: 'unknown_email_id' }
  );
  // Soft bounces and deliveries on unlogged mail change nothing.
  assert.deepEqual(await applyResendEvent(nobody, event('email.delivered', { email_id: 're_x' })), { status: 'ignored', reason: 'unknown_email_id' });
  assert.deepEqual(await applyResendEvent(nobody, event('email.bounced', { email_id: 're_x', bounce: { type: 'Transient' } })), { status: 'ignored', reason: 'unknown_email_id' });
});

test('a missing or junk created_at falls back to now', async () => {
  const admin = seed();
  const now = new Date('2026-10-20T08:00:00.000Z');
  await applyResendEvent(admin, { type: 'email.opened', data: { email_id: 're_1' } }, now);
  assert.equal(admin.tables.message_log[0].opened_at, now.toISOString());
  const second = seed();
  await applyResendEvent(second, { type: 'email.opened', created_at: 'yesterday-ish', data: { email_id: 're_1' } }, now);
  assert.equal(second.tables.message_log[0].opened_at, now.toISOString());
});

function webhookRequest(body: string, headers: Record<string, string>) {
  return new NextRequest('https://ai.modaafa.com/api/webhooks/resend', { method: 'POST', headers, body });
}

function signedHeaders(body: string, id = 'msg_route', ts = Math.floor(Date.now() / 1000), key: Buffer = KEY) {
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sign(id, ts, body, key), 'content-type': 'application/json' };
}

test('webhook route: 503 when the secret is not configured', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: undefined }, async () => {
    const res = await webhookPost(webhookRequest(BODY, signedHeaders(BODY)));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'webhook_secret_missing' });
  }));

test('webhook route: 503 also for a blank or placeholder secret', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: '   ' }, async () => {
    const res = await webhookPost(webhookRequest(BODY, signedHeaders(BODY)));
    assert.equal(res.status, 503);
  }));

test('webhook route: 401 for a missing, wrong, stale or tampered signature, and nothing is read from the database', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: SECRET, ...FAKE_SUPABASE_ENV }, async () => {
    const db = installFakePostgrest({ message_log: [{ id: 'log-1', user_id: U, provider_id: 're_1', delivered_at: null }] });
    try {
      const cases: Array<[string, Record<string, string>, string]> = [
        ['no headers', {}, BODY],
        ['wrong key', signedHeaders(BODY, 'm', undefined, Buffer.from('not-the-key')), BODY],
        ['stale', signedHeaders(BODY, 'm', Math.floor(Date.now() / 1000) - 3600), BODY],
        ['tampered body', signedHeaders(BODY), BODY.replace('re_1', 're_2')],
      ];
      for (const [name, headers, body] of cases) {
        const res = await webhookPost(webhookRequest(body, headers));
        assert.equal(res.status, 401, name);
        assert.deepEqual(await res.json(), { error: 'invalid_signature' }, name);
      }
      assert.equal(db.calls.length, 0);
      assert.equal(db.tables.message_log[0].delivered_at, null);
    } finally {
      db.restore();
    }
  }));

test('webhook route: a signed delivered event is applied, and Svix delivering it twice is harmless', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: SECRET, ...FAKE_SUPABASE_ENV }, async () => {
    const db = installFakePostgrest({
      users: [{ id: U, email: 'sara@example.com', email_prefs: {} }],
      message_log: [{ id: 'log-1', user_id: U, channel: 'email', provider_id: 're_1', delivered_at: null }],
    });
    try {
      const body = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-14T10:00:00.000Z', data: { email_id: 're_1', to: ['sara@example.com'] } });
      const first = await webhookPost(webhookRequest(body, signedHeaders(body)));
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { received: true, status: 'applied' });
      assert.equal(db.tables.message_log[0].delivered_at, '2026-10-14T10:00:00.000Z');

      const second = await webhookPost(webhookRequest(body, signedHeaders(body)));
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { received: true, status: 'duplicate' });
    } finally {
      db.restore();
    }
  }));

test('webhook route: a signed hard bounce suppresses the user', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: SECRET, ...FAKE_SUPABASE_ENV }, async () => {
    const db = installFakePostgrest({
      users: [{ id: U, email: 'sara@example.com', email_prefs: {}, email_suppressed_at: null }],
      message_log: [{ id: 'log-1', user_id: U, channel: 'email', provider_id: 're_1', bounced_at: null }],
    });
    try {
      const body = JSON.stringify({ type: 'email.bounced', created_at: '2026-10-14T10:00:00.000Z', data: { email_id: 're_1', bounce: { type: 'Permanent' } } });
      const res = await webhookPost(webhookRequest(body, signedHeaders(body)));
      assert.equal(res.status, 200);
      assert.equal(db.tables.users[0].email_suppressed_at, '2026-10-14T10:00:00.000Z');
      assert.equal(db.tables.users[0].email_suppressed_reason, 'hard_bounce');
    } finally {
      db.restore();
    }
  }));

test('webhook route: an unknown email id and an unhandled event type are 200, never 500', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: SECRET, ...FAKE_SUPABASE_ENV }, async () => {
    const db = installFakePostgrest({ message_log: [] , users: [] });
    try {
      for (const payload of [
        { type: 'email.delivered', data: { email_id: 're_nobody' } },
        { type: 'email.sent', data: { email_id: 're_nobody' } },
        { type: 'contact.created', data: {} },
        { type: 'email.opened' },
      ]) {
        const body = JSON.stringify(payload);
        const res = await webhookPost(webhookRequest(body, signedHeaders(body)));
        assert.equal(res.status, 200, body);
        assert.equal((await res.json()).received, true);
      }
    } finally {
      db.restore();
    }
  }));

test('webhook route: a signed body that is not JSON is 400', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: SECRET, ...FAKE_SUPABASE_ENV }, async () => {
    for (const body of ['not json', '[]', 'null', '"x"']) {
      const res = await webhookPost(webhookRequest(body, signedHeaders(body)));
      assert.equal(res.status, 400, body);
    }
  }));

test('webhook route: 503 when the service role is missing, 500 when the database fails (so Resend retries)', () =>
  withEnv({ RESEND_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    const log = console.error;
    console.error = () => {};
    try {
      const noDb = await webhookPost(webhookRequest(BODY, signedHeaders(BODY)));
      assert.equal(noDb.status, 503);

      await withEnv(FAKE_SUPABASE_ENV, async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch;
        try {
          const res = await webhookPost(webhookRequest(BODY, signedHeaders(BODY)));
          assert.equal(res.status, 500);
        } finally {
          globalThis.fetch = realFetch;
        }
      });
    } finally {
      console.error = log;
    }
  }));
