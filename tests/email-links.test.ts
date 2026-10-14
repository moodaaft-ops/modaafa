import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { isSafeInternalPath, trackedUrl, verifyTrackedLink, withUtm } from '../lib/messaging/links';
import { buildOptOutUrl, verifyOptOutToken } from '../lib/messaging/opt-out';
import { buildPreferencesUrl, verifyPreferencesToken } from '../lib/messaging/prefs';
import { recordClick } from '../lib/messaging/click';
import { GET as clickGet, HEAD as clickHead } from '../app/m/c/route';
import { createFakeAdmin } from './support/fake-admin';
import { withEnv } from './support/with-env';

const USER_ID = '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const env = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com' };

function paramsOf(url: string) {
  const parsed = new URL(url);
  return {
    u: parsed.searchParams.get('u'),
    k: parsed.searchParams.get('k'),
    p: parsed.searchParams.get('p'),
    s: parsed.searchParams.get('s'),
  };
}

test('trackedUrl points at /m/c on the app origin and carries a signature', () =>
  withEnv(env, () => {
    const url = trackedUrl(USER_ID, 'registered_1d', '/onboarding/connect')!;
    assert.match(url, /^https:\/\/ai\.modaafa\.com\/m\/c\?/);
    const p = paramsOf(url);
    assert.equal(p.u, USER_ID);
    assert.equal(p.k, 'registered_1d');
    assert.equal(p.p, '/onboarding/connect');
    assert.ok(p.s && p.s.length >= 40);
    assert.deepEqual(verifyTrackedLink(p), {
      userId: USER_ID,
      templateKey: 'registered_1d',
      target: '/onboarding/connect?utm_source=email&utm_medium=lifecycle&utm_campaign=registered_1d',
    });
  }));

test('trackedUrl keeps an existing query and replaces utm parameters already on the path', () =>
  withEnv(env, () => {
    const url = trackedUrl(USER_ID, 'weekly_report_2026-W42', '/billing?plan=growth&utm_source=x#top')!;
    const click = verifyTrackedLink(paramsOf(url))!;
    assert.equal(
      click.target,
      '/billing?plan=growth&utm_source=email&utm_medium=lifecycle&utm_campaign=weekly_report_2026-W42#top'
    );
    assert.equal(withUtm('/home', 'trial_d1'), '/home?utm_source=email&utm_medium=lifecycle&utm_campaign=trial_d1');
  }));

test('trackedUrl cannot be built without a signing key, or for a bad user, key or path', () => {
  withEnv({ UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
    assert.equal(trackedUrl(USER_ID, 'registered_1d', '/home'), null);
  });
  withEnv(env, () => {
    assert.equal(trackedUrl('user-1', 'registered_1d', '/home'), null);
    assert.equal(trackedUrl(USER_ID, 'has space', '/home'), null);
    assert.equal(trackedUrl(USER_ID, '', '/home'), null);
    assert.equal(trackedUrl(USER_ID, 'a'.repeat(81), '/home'), null);
    assert.equal(trackedUrl(USER_ID, 'registered_1d', 'https://evil.com'), null);
  });
});

test('a signature only works for the user, template and path it was made for', () =>
  withEnv(env, () => {
    const p = paramsOf(trackedUrl(USER_ID, 'registered_1d', '/home')!);
    assert.ok(verifyTrackedLink(p));
    assert.equal(verifyTrackedLink({ ...p, u: OTHER_ID }), null);
    assert.equal(verifyTrackedLink({ ...p, k: 'registered_3d' }), null);
    assert.equal(verifyTrackedLink({ ...p, p: '/billing' }), null);
    assert.equal(verifyTrackedLink({ ...p, s: `${p.s}x` }), null);
    assert.equal(verifyTrackedLink({ ...p, s: p.s!.slice(0, -2) }), null);
    assert.equal(verifyTrackedLink({ ...p, s: null }), null);
    assert.equal(verifyTrackedLink({ ...p, u: null }), null);
    // A signature from a different secret does not verify.
    const foreign = withEnv({ UNSUBSCRIBE_SECRET: 'another-secret' }, () => paramsOf(trackedUrl(USER_ID, 'registered_1d', '/home')!));
    assert.equal(verifyTrackedLink(foreign), null);
  }));

test('the three signed link kinds never accept each other\'s tokens', () =>
  withEnv(env, () => {
    const optOutToken = new URL(buildOptOutUrl(USER_ID)!).searchParams.get('t');
    const prefsToken = new URL(buildPreferencesUrl(USER_ID)!).searchParams.get('t');
    const clickToken = paramsOf(trackedUrl(USER_ID, 'registered_1d', '/home')!).s;
    assert.notEqual(optOutToken, prefsToken);
    assert.equal(verifyOptOutToken(USER_ID, optOutToken), true);
    assert.equal(verifyOptOutToken(USER_ID, prefsToken), false);
    assert.equal(verifyOptOutToken(USER_ID, clickToken), false);
    assert.equal(verifyPreferencesToken(USER_ID, prefsToken), true);
    assert.equal(verifyPreferencesToken(USER_ID, optOutToken), false);
    assert.equal(verifyPreferencesToken(OTHER_ID, prefsToken), false);
    assert.equal(verifyPreferencesToken(USER_ID, null), false);
  }));

test('the opt-out token is byte-for-byte what PR #81 produced (old links keep working)', () =>
  withEnv(env, () => {
    // HMAC-SHA256("test-secret-value", "messages_opt_out:" + userId), base64url.
    const legacy = createHmac('sha256', 'test-secret-value').update(`messages_opt_out:${USER_ID}`).digest('base64url');
    assert.equal(new URL(buildOptOutUrl(USER_ID)!).searchParams.get('t'), legacy);
    assert.equal(verifyOptOutToken(USER_ID, legacy), true);
  }));

const UNSAFE_PATHS = [
  '//evil.com',
  '//evil.com/path',
  '/\\evil.com',
  '/\\/evil.com',
  '\\\\evil.com',
  '\\evil.com',
  'https://evil.com',
  'http://evil.com/x',
  'HTTPS://evil.com',
  'evil.com',
  'javascript:alert(1)',
  '/javascript:alert(1)\\',
  '',
  ' /home',
  '/ /evil.com',
  '/\t/evil.com',
  '/\n/evil.com',
  '/\r/evil.com',
  '/\u0000/evil.com',
  '/%2F/evil.com',
  '/%2f/evil.com',
  '/%5Cevil.com',
  '/%5cevil.com',
  '/%09/evil.com',
  '/%0a/evil.com',
  '/%E0%A4%A',
  '/home\\..\\evil',
  '/a'.padEnd(700, 'a'),
];

test('isSafeInternalPath refuses every shape of off-site or malformed target', () => {
  for (const path of UNSAFE_PATHS) {
    assert.equal(isSafeInternalPath(path), false, JSON.stringify(path));
  }
  assert.equal(isSafeInternalPath(undefined), false);
  assert.equal(isSafeInternalPath(null), false);
  assert.equal(isSafeInternalPath(42), false);
});

test('isSafeInternalPath accepts ordinary app paths', () => {
  for (const path of [
    '/',
    '/home',
    '/onboarding/connect',
    '/billing?plan=growth',
    '/audit#top',
    '/reports?from=2026-10-01&to=2026-10-14',
    '/assistant?q=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7',
    '/billing?next=%2Fhome',
  ]) {
    assert.equal(isSafeInternalPath(path), true, path);
  }
});

test('a validly signed unsafe path still cannot be minted or verified', () =>
  withEnv(env, () => {
    for (const path of UNSAFE_PATHS) {
      assert.equal(trackedUrl(USER_ID, 'registered_1d', path), null, JSON.stringify(path));
    }
  }));

function clickRequest(query: Record<string, string>, method = 'GET') {
  const url = new URL('https://ai.modaafa.com/m/c');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { method });
}

test('/m/c redirects a valid link to the relative target with utm and never to another host', () =>
  withEnv(env, async () => {
    const p = paramsOf(trackedUrl(USER_ID, 'registered_1d', '/onboarding/connect')!);
    const log = console.error;
    console.error = () => {}; // no database in this test: the click is not recorded, the redirect still happens
    try {
      const res = await clickGet(clickRequest({ u: p.u!, k: p.k!, p: p.p!, s: p.s! }));
      assert.equal(res.status, 302);
      assert.equal(
        res.headers.get('location'),
        '/onboarding/connect?utm_source=email&utm_medium=lifecycle&utm_campaign=registered_1d'
      );
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      console.error = log;
    }
  }));

test('/m/c sends every bad link to the home page', () =>
  withEnv(env, async () => {
    const good = paramsOf(trackedUrl(USER_ID, 'registered_1d', '/home')!);
    const bad: Array<Record<string, string>> = [
      {},
      { u: good.u!, k: good.k!, p: good.p! },
      { u: good.u!, k: good.k!, p: good.p!, s: 'nope' },
      { u: good.u!, k: good.k!, p: '/billing', s: good.s! },
      { u: good.u!, k: good.k!, p: '//evil.com', s: good.s! },
      { u: good.u!, k: good.k!, p: 'https://evil.com', s: good.s! },
      { u: OTHER_ID, k: good.k!, p: good.p!, s: good.s! },
    ];
    for (const query of bad) {
      const res = await clickGet(clickRequest(query));
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/', JSON.stringify(query));
    }
  }));

test('/m/c: even a signature made by us for an off-site path is refused at verification', () =>
  withEnv(env, async () => {
    // Forge what an attacker with a leaked secret would send: it must still fail the path rule.
    for (const path of ['//evil.com', '/\\evil.com', 'https://evil.com', '/%2F/evil.com']) {
      const s = createHmac('sha256', 'test-secret-value')
        .update(`email_click:${USER_ID}:registered_1d:${path}`)
        .digest('base64url');
      const res = await clickGet(clickRequest({ u: USER_ID, k: 'registered_1d', p: path, s }));
      assert.equal(res.headers.get('location'), '/', path);
    }
  }));

test('/m/c answers HEAD with the same redirect and records nothing', () =>
  withEnv(env, async () => {
    const p = paramsOf(trackedUrl(USER_ID, 'registered_1d', '/home')!);
    const res = await clickHead(clickRequest({ u: p.u!, k: p.k!, p: p.p!, s: p.s! }, 'HEAD'));
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /^\/home\?utm_source=email/);
  }));

test('recordClick stamps the first click, counts every click and ignores unlogged mail', async () => {
  const admin = createFakeAdmin({
    message_log: [
      { id: 'm1', user_id: USER_ID, channel: 'email', template: 'registered_1d', status: 'sent', clicked_at: null, click_count: 0 },
    ],
  });
  const first = new Date('2026-10-14T10:00:00Z');
  const second = new Date('2026-10-14T11:00:00Z');
  assert.deepEqual(await recordClick(admin, USER_ID, 'registered_1d', first), { recorded: true });
  assert.deepEqual(await recordClick(admin, USER_ID, 'registered_1d', second), { recorded: true });
  const row = admin.tables.message_log[0];
  assert.equal(row.clicked_at, first.toISOString());
  assert.equal(row.click_count, 2);
  assert.deepEqual(await recordClick(admin, USER_ID, 'tx_payment_failed', second), { recorded: false });
  assert.deepEqual(await recordClick(admin, OTHER_ID, 'registered_1d', second), { recorded: false });
});
