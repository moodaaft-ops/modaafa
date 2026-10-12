import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOptOutUrl, verifyOptOutToken } from '../lib/messaging/opt-out';
import { firstName, renderWelcomeAdsConnect } from '../lib/messaging/templates';
import { send } from '../lib/messaging/send';

const USER_ID = '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Minimal in-memory stand-in for the two tables and claim_message. */
function fakeSupabase(opts: { claimResults?: boolean[] } = {}) {
  const claims = [...(opts.claimResults ?? [true])];
  const updates: any[] = [];
  const events: any[] = [];
  return {
    updates,
    events,
    rpc: async () => ({ data: claims.length > 1 ? claims.shift() : claims[0], error: null }),
    from: (table: string) => ({
      update: (patch: any) => ({
        eq: () => ({ eq: () => ({ eq: async () => { updates.push({ table, patch }); return { error: null }; } }) }),
      }),
      insert: async (row: any) => { events.push({ table, row }); return { error: null }; },
    }),
  };
}

const env = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com' };
const user = { id: USER_ID, email: 'client@example.com', name: 'أيمن أمين', messages_opt_out: false };

test('opt-out token verifies only for the right user and survives tampering checks', () =>
  withEnv(env, () => {
    const url = new URL(buildOptOutUrl(USER_ID)!);
    const t = url.searchParams.get('t');
    assert.equal(verifyOptOutToken(USER_ID, t), true);
    assert.equal(verifyOptOutToken('11111111-1111-1111-1111-111111111111', t), false);
    assert.equal(verifyOptOutToken(USER_ID, `${t}x`), false);
    assert.equal(verifyOptOutToken(USER_ID, null), false);
  }));

test('opt-out link cannot be built without a signing key', () =>
  withEnv({ UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
    assert.equal(buildOptOutUrl(USER_ID), null);
    assert.equal(renderWelcomeAdsConnect(user), null);
  }));

test('welcome email is RTL-safe, links to /welcome, carries opt-out and one-click headers', () =>
  withEnv(env, () => {
    const mail = renderWelcomeAdsConnect(user)!;
    assert.match(mail.html, /هلا أيمن</);
    assert.match(mail.html, /href="https:\/\/ai\.modaafa\.com\/welcome"/);
    assert.match(mail.footer, /\/api\/messages\/opt-out\?u=/);
    assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/ai\.modaafa\.com\/api\/messages\/opt-out/);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    // house rules: no long dashes, no Latin comma in the Arabic copy
    assert.doesNotMatch(mail.subject + mail.html + mail.footer, /[—–]/);
    assert.doesNotMatch(mail.subject + mail.html, /,/);
  }));

test('greeting escapes the name and drops absurd ones', () => {
  assert.equal(firstName('  سارة   العتيبي '), 'سارة');
  assert.equal(firstName(null), '');
  assert.equal(firstName('x'.repeat(80)), '');
  withEnv(env, () => {
    const mail = renderWelcomeAdsConnect({ ...user, name: '<script>alert(1)</script>' })!;
    assert.doesNotMatch(mail.html, /<script>/);
  });
});

test('send() mails once, logs it and records welcome_email_sent', async () =>
  withEnv(env, async () => {
    const db = fakeSupabase();
    const calls: any[] = [];
    const result = await send('email', 'welcome_ads_connect', user, {
      supabase: db,
      emailConfigured: () => true,
      sendEmail: async (payload) => { calls.push(payload); return { sent: true, id: 'resend_1' }; },
    });
    assert.deepEqual(result, { status: 'sent', providerId: 'resend_1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].idempotencyKey, `welcome_ads_connect-${USER_ID}`);
    assert.equal(db.updates[0].patch.status, 'sent');
    assert.equal(db.events[0].row.event, 'welcome_email_sent');
    assert.equal(db.events[0].row.stage, 'registered');
  }));

test('send() does not mail when the claim is lost (second call for the same person)', async () =>
  withEnv(env, async () => {
    const db = fakeSupabase({ claimResults: [false] });
    let sent = 0;
    const result = await send('email', 'welcome_ads_connect', user, {
      supabase: db,
      emailConfigured: () => true,
      sendEmail: async () => { sent += 1; return { sent: true, id: 'x' }; },
    });
    assert.deepEqual(result, { status: 'duplicate' });
    assert.equal(sent, 0);
    assert.equal(db.events.length, 0);
  }));

test('send() honours messages_opt_out and logs it as skipped', async () =>
  withEnv(env, async () => {
    const db = fakeSupabase();
    let sent = 0;
    const result = await send('email', 'welcome_ads_connect', { ...user, messages_opt_out: true }, {
      supabase: db,
      emailConfigured: () => true,
      sendEmail: async () => { sent += 1; return { sent: true, id: 'x' }; },
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'opted_out' });
    assert.equal(sent, 0);
    assert.equal(db.updates[0].patch.status, 'skipped');
  }));

test('send() marks failed when the provider throws, and records no event', async () =>
  withEnv(env, async () => {
    const db = fakeSupabase();
    const result = await send('email', 'welcome_ads_connect', user, {
      supabase: db,
      emailConfigured: () => true,
      sendEmail: async () => { throw new Error('Resend returned 422'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(db.updates[0].patch.status, 'failed');
    assert.equal(db.events.length, 0);
  }));

test('send() refuses whatsapp for now and does nothing when email is not configured', async () =>
  withEnv(env, async () => {
    const db = fakeSupabase();
    assert.deepEqual(await send('whatsapp', 'welcome_ads_connect', user, { supabase: db }), { status: 'channel_unsupported' });
    assert.deepEqual(
      await send('email', 'welcome_ads_connect', user, { supabase: db, emailConfigured: () => false }),
      { status: 'not_configured' }
    );
    assert.equal(db.updates.length + db.events.length, 0);
  }));
