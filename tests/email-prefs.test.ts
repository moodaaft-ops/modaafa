import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  allOptionalOff,
  buildPreferencesUrl,
  isCategoryOn,
  normalizePrefs,
  optionalState,
  updatePrefs,
  verifyPreferencesToken,
} from '../lib/messaging/prefs';
import { EMAIL_CATEGORIES } from '../lib/lifecycle/types';
import { buildOptOutUrl } from '../lib/messaging/opt-out';
import { POST as savePrefs } from '../app/api/messages/preferences/route';
import { GET as optOutGet, POST as optOutPost } from '../app/api/messages/opt-out/route';
import { createFakeAdmin } from './support/fake-admin';
import { FAKE_SUPABASE_ENV, installFakePostgrest } from './support/fake-postgrest';
import { withEnv } from './support/with-env';

const U = '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33';
const OTHER = '11111111-1111-4111-8111-111111111111';
const env = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com' };

test('isCategoryOn: a missing key means on', () => {
  for (const category of EMAIL_CATEGORIES) {
    assert.equal(isCategoryOn({}, false, category), true, category);
    assert.equal(isCategoryOn(null, false, category), true, category);
    assert.equal(isCategoryOn(undefined, undefined, category), true, category);
  }
});

test('isCategoryOn: an explicit false turns one category off and leaves the others', () => {
  const prefs = { lifecycle: false, weekly_report: true };
  assert.equal(isCategoryOn(prefs, false, 'lifecycle'), false);
  assert.equal(isCategoryOn(prefs, false, 'weekly_report'), true);
  assert.equal(isCategoryOn(prefs, false, 'product_news'), true);
});

test('isCategoryOn: the one-click stop switches every optional category off', () => {
  for (const category of ['onboarding', 'lifecycle', 'weekly_report', 'product_news'] as const) {
    assert.equal(isCategoryOn({}, true, category), false, category);
    assert.equal(isCategoryOn({ [category]: true }, true, category), false, category);
  }
});

test('isCategoryOn: transactional cannot be switched off by anything', () => {
  assert.equal(isCategoryOn({ transactional: false }, true, 'transactional'), true);
  assert.equal(isCategoryOn({}, true, 'transactional'), true);
});

test('normalizePrefs keeps only known categories with real booleans', () => {
  assert.deepEqual(normalizePrefs({ lifecycle: false, weekly_report: 'no', bogus: false, product_news: true }), {
    lifecycle: false,
    product_news: true,
  });
  assert.deepEqual(normalizePrefs(null), {});
  assert.deepEqual(normalizePrefs('x'), {});
  assert.deepEqual(normalizePrefs([false]), {});
});

test('optionalState: what the checkboxes show', () => {
  assert.deepEqual(optionalState({ weekly_report: false }, false), { lifecycle: true, weekly_report: false, product_news: true });
  assert.deepEqual(optionalState({}, true), { lifecycle: false, weekly_report: false, product_news: false });
});

test('the preferences link is signed per user and verifies only for that user', () =>
  withEnv(env, () => {
    const url = new URL(buildPreferencesUrl(U)!);
    assert.equal(url.origin + url.pathname, 'https://ai.modaafa.com/email-preferences');
    const t = url.searchParams.get('t');
    assert.equal(url.searchParams.get('u'), U);
    assert.equal(verifyPreferencesToken(U, t), true);
    assert.equal(verifyPreferencesToken(OTHER, t), false);
    assert.equal(verifyPreferencesToken(U, `${t}0`), false);
    assert.equal(buildPreferencesUrl('not-a-uuid'), null);
    withEnv({ UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
      assert.equal(buildPreferencesUrl(U), null);
      assert.equal(verifyPreferencesToken(U, t), false);
    });
  }));

test('updatePrefs writes all three keys from the checkboxes and keeps other keys', async () => {
  const admin = createFakeAdmin({ users: [{ id: U, email_prefs: { onboarding: true, lifecycle: true }, messages_opt_out: false }] });
  const result = await updatePrefs(admin, U, { choices: { weekly_report: true } });
  assert.deepEqual(result, {
    ok: true,
    prefs: { onboarding: true, lifecycle: false, weekly_report: true, product_news: false },
    messagesOptOut: false,
  });
  assert.deepEqual(admin.tables.users[0].email_prefs, { onboarding: true, lifecycle: false, weekly_report: true, product_news: false });
});

test('updatePrefs stopAll is what the one-click link does: every optional off and messages_opt_out set', async () => {
  const admin = createFakeAdmin({ users: [{ id: U, email_prefs: {}, messages_opt_out: false }] });
  const now = new Date('2026-10-14T10:00:00Z');
  const result = await updatePrefs(admin, U, { stopAll: true }, now);
  assert.equal(result.ok, true);
  const row = admin.tables.users[0];
  assert.deepEqual(row.email_prefs, { lifecycle: false, weekly_report: false, product_news: false });
  assert.equal(row.messages_opt_out, true);
  assert.equal(row.messages_opt_out_at, now.toISOString());
  assert.deepEqual(optionalState(row.email_prefs, row.messages_opt_out), { lifecycle: false, weekly_report: false, product_news: false });
});

test('updatePrefs: ticking a box after the one-click stop opts the person back in', async () => {
  const admin = createFakeAdmin({
    users: [{ id: U, email_prefs: {}, messages_opt_out: true, messages_opt_out_at: '2026-10-01T00:00:00Z' }],
  });
  const result = await updatePrefs(admin, U, { choices: { lifecycle: true } });
  assert.equal(result.ok, true);
  const row = admin.tables.users[0];
  assert.equal(row.messages_opt_out, false);
  assert.deepEqual(optionalState(row.email_prefs, row.messages_opt_out), { lifecycle: true, weekly_report: false, product_news: false });
});

test('updatePrefs: unticking everything does not set the one-click flag', async () => {
  const admin = createFakeAdmin({ users: [{ id: U, email_prefs: {}, messages_opt_out: false }] });
  await updatePrefs(admin, U, { choices: {} });
  assert.equal(admin.tables.users[0].messages_opt_out, false);
  assert.deepEqual(admin.tables.users[0].email_prefs, { lifecycle: false, weekly_report: false, product_news: false });
});

test('updatePrefs: unknown user and database errors are reported, not thrown', async () => {
  const admin = createFakeAdmin({ users: [] });
  assert.deepEqual(await updatePrefs(admin, U, { stopAll: true }), { ok: false, reason: 'user_not_found' });

  const failing = createFakeAdmin({ users: [{ id: U, email_prefs: {}, messages_opt_out: false }] });
  const realFrom = failing.from.bind(failing);
  (failing as any).from = (table: string) => {
    const query: any = realFrom(table);
    const realUpdate = query.update.bind(query);
    query.update = (patch: any) => {
      const chain: any = realUpdate(patch);
      chain.then = (resolve: any) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
      return chain;
    };
    return query;
  };
  assert.deepEqual(await updatePrefs(failing, U, { stopAll: true }), { ok: false, reason: 'update_failed' });
});

test('allOptionalOff keeps other keys', () => {
  assert.deepEqual(allOptionalOff({ onboarding: true, lifecycle: true }), {
    onboarding: true,
    lifecycle: false,
    weekly_report: false,
    product_news: false,
  });
});

function form(fields: Record<string, string>) {
  return new NextRequest('https://ai.modaafa.com/api/messages/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

test('POST /api/messages/preferences saves only with a valid signed link and answers with a 303 back to the page', () =>
  withEnv({ ...env, ...FAKE_SUPABASE_ENV }, async () => {
    const db = installFakePostgrest({
      users: [{ id: U, email: 'sara@example.com', email_prefs: {}, messages_opt_out: false }],
    });
    try {
      const t = new URL(buildPreferencesUrl(U)!).searchParams.get('t')!;

      const bad = await savePrefs(form({ u: U, t: 'forged', intent: 'save', lifecycle: 'on' }));
      assert.equal(bad.status, 303);
      assert.equal(bad.headers.get('location'), '/email-preferences');
      assert.equal(db.calls.filter((c) => c.method === 'PATCH').length, 0);

      const wrongUser = await savePrefs(form({ u: OTHER, t, intent: 'save' }));
      assert.equal(wrongUser.headers.get('location'), '/email-preferences');
      assert.equal(db.calls.filter((c) => c.method === 'PATCH').length, 0);

      const saved = await savePrefs(form({ u: U, t, intent: 'save', lifecycle: 'on', product_news: 'on' }));
      assert.equal(saved.status, 303);
      assert.equal(saved.headers.get('location'), `/email-preferences?u=${U}&t=${t}&r=saved`);
      assert.deepEqual(db.tables.users[0].email_prefs, { lifecycle: true, weekly_report: false, product_news: true });

      const stopped = await savePrefs(form({ u: U, t, intent: 'stop_all', lifecycle: 'on' }));
      assert.match(stopped.headers.get('location')!, /&r=stopped$/);
      assert.deepEqual(db.tables.users[0].email_prefs, { lifecycle: false, weekly_report: false, product_news: false });
      assert.equal(db.tables.users[0].messages_opt_out, true);
    } finally {
      db.restore();
    }
  }));

test('POST /api/messages/preferences reports a database failure as r=error and never throws', () =>
  withEnv({ ...env, UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    const t = new URL(buildPreferencesUrl(U)!).searchParams.get('t')!;
    const log = console.error;
    console.error = () => {};
    try {
      const res = await savePrefs(form({ u: U, t, intent: 'save' }));
      assert.equal(res.status, 303);
      assert.match(res.headers.get('location')!, /&r=error$/);
    } finally {
      console.error = log;
    }
  }));

test('#81 one-click stop keeps working: GET only confirms, POST sets messages_opt_out, and the page links to the preferences', () =>
  withEnv({ ...env, ...FAKE_SUPABASE_ENV }, async () => {
    const db = installFakePostgrest({ users: [{ id: U, messages_opt_out: false }] });
    try {
      const url = new URL(buildOptOutUrl(U)!);
      const req = (method: string) => new NextRequest(url, { method });

      const confirm = await optOutGet(req('GET'));
      assert.equal(confirm.status, 200);
      const html = await confirm.text();
      assert.match(html, /<form method="post"/);
      assert.match(html, /\/email-preferences\?u=/);
      assert.equal(db.calls.filter((c) => c.method === 'PATCH').length, 0, 'GET must not change anything');

      const done = await optOutPost(req('POST'));
      assert.equal(done.status, 200);
      assert.equal(db.tables.users[0].messages_opt_out, true);
      assert.match(await done.text(), /\/email-preferences\?u=/);

      const forged = await optOutPost(new NextRequest(`https://ai.modaafa.com/api/messages/opt-out?u=${OTHER}&t=${url.searchParams.get('t')}`, { method: 'POST' }));
      assert.equal(forged.status, 400);
    } finally {
      db.restore();
    }
  }));
