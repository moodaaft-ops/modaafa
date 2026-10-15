import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleProvisionGet,
  handleProvisionPost,
  type ProvisionGetDeps,
  type ProvisionPostDeps,
} from '../lib/provisioning/handler';
import { FakeGoogle, MemoryStore, restError } from './fixtures/provisioning-fakes';

const USER = { id: 'user-1', email: 'ahmed.ali@gmail.com' };

function postDeps(overrides: Partial<ProvisionPostDeps> = {}) {
  const google = new FakeGoogle();
  const store = new MemoryStore();
  const deps: ProvisionPostDeps = {
    isSameOrigin: () => true,
    getUser: async () => USER,
    isEnabledFor: () => true,
    rateLimit: async () => ({ allowed: true }),
    isRegistered: async () => true,
    loadAds: async () => google.context(),
    store,
    unlinkAfterAccept: false,
    readBody: async () => ({}),
    ...overrides,
  };
  return { deps, google, store };
}

test('POST: a cross-site request is refused before anything else', async () => {
  const { deps, google } = postDeps({ isSameOrigin: () => false });
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'invalid_origin');
  assert.equal(google.calls.length, 0);
});

test('POST: no session is 401', async () => {
  const { deps, google } = postDeps({ getUser: async () => null });
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 401);
  assert.equal(google.calls.length, 0);
});

test('POST: the flag off for this user answers 404 and touches neither the limiter, the database nor Google', async () => {
  let touched = 0;
  const { deps, google } = postDeps({
    isEnabledFor: () => false,
    rateLimit: async () => {
      touched += 1;
      return { allowed: true };
    },
    isRegistered: async () => {
      touched += 1;
      return true;
    },
  });
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'not_available');
  assert.equal(touched, 0);
  assert.equal(google.calls.length, 0);
});

test('POST: too many presses are 429 with the limiter\'s headers, and a broken limiter fails closed', async () => {
  const limited = postDeps({ rateLimit: async () => ({ allowed: false, headers: { 'Retry-After': '30' } }) });
  const a = await handleProvisionPost(limited.deps);
  assert.equal(a.status, 429);
  assert.equal(a.headers?.['Retry-After'], '30');
  assert.equal(limited.google.calls.length, 0);

  const broken = postDeps({
    rateLimit: async () => {
      throw new Error('store down');
    },
  });
  const b = await handleProvisionPost(broken.deps);
  assert.equal(b.status, 503);
  assert.equal(broken.google.calls.length, 0);
});

test('POST: a user who has not finished registering gets 403, and an unreadable registration fails closed', async () => {
  const unregistered = postDeps({ isRegistered: async () => false });
  const a = await handleProvisionPost(unregistered.deps);
  assert.equal(a.status, 403);
  assert.equal(a.body.error, 'registration_incomplete');
  assert.equal(unregistered.google.calls.length, 0);

  const unreadable = postDeps({
    isRegistered: async () => {
      throw new Error('read failed');
    },
  });
  const b = await handleProvisionPost(unreadable.deps);
  assert.equal(b.status, 500);
  assert.equal(unreadable.google.calls.length, 0, 'a failed read never lets a user through');
});

test('POST: no manager token configured is 503 and creates nothing', async () => {
  const { deps, google, store } = postDeps({ loadAds: async () => null });
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'not_configured');
  assert.equal(google.calls.length, 0);
  assert.equal(store.rows.size, 0, 'no row is left behind');
});

test('POST: a registered user gets the account and the view the browser may see', async () => {
  const { deps, google } = postDeps();
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, provision: { status: 'invited', invitedEmail: 'ahmed.ali@gmail.com', canRetry: false } });
  assert.equal(google.creates, 1);
  assert.ok(!JSON.stringify(result.body).includes([...google.accounts.keys()][0]), 'the Google customer id is not sent to the browser');
});

test('POST: a second press returns the existing request and creates nothing', async () => {
  let body: Record<string, unknown> = {};
  const { deps, google } = postDeps({ readBody: async () => body });
  const first = await handleProvisionPost(deps);
  body = { email: 'someone.else@gmail.com' };
  const second = await handleProvisionPost(deps);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(google.creates, 1, 'one press, one account');
  assert.equal(google.invites, 1);
  assert.equal((second.body.provision as any).invitedEmail, 'ahmed.ali@gmail.com', 'a second press cannot redirect the invitation to another email');
});

test('POST: a bad email in the body is 400 and creates nothing', async () => {
  const { deps, google } = postDeps({ readBody: async () => ({ email: 'nope' }) });
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_email');
  assert.equal(google.calls.length, 0);
});

test('POST: a failed request can be tried again, a request in any other state cannot', async () => {
  const { deps, google, store } = postDeps();
  google.failNext((request) => request.path.endsWith(':createCustomerClient'), restError(403, 'USER_PERMISSION_DENIED'));
  const failed = await handleProvisionPost(deps);
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.body.provision, { status: 'failed', invitedEmail: 'ahmed.ali@gmail.com', canRetry: true });

  const retried = await handleProvisionPost(deps);
  assert.equal((retried.body.provision as any).status, 'invited');
  assert.equal(google.creates, 2);

  const again = await handleProvisionPost(deps);
  assert.equal((again.body.provision as any).status, 'invited');
  assert.equal(google.creates, 2, 'an invited request is never created again');

  for (const status of ['creating', 'accepted', 'unlinked', 'expired'] as const) {
    store.rows.get(USER.id)!.status = status;
    const result = await handleProvisionPost(deps);
    assert.equal((result.body.provision as any).status, status);
    assert.equal(google.creates, 2);
  }
});

test('POST: a database fault is a 500 with no detail', async () => {
  const { deps } = postDeps();
  deps.store.get = async () => {
    throw new Error('relation "ads_account_provisions" does not exist');
  };
  const result = await handleProvisionPost(deps);
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { ok: false, error: 'provision_failed' });
});

function getDeps(overrides: Partial<ProvisionGetDeps> = {}) {
  const google = new FakeGoogle();
  const store = new MemoryStore();
  const deps: ProvisionGetDeps = {
    getUser: async () => USER,
    loadState: async (user) => ({ available: true, row: await store.get(user.id) }),
    loadAds: async () => google.context(),
    store,
    unlinkAfterAccept: false,
    ...overrides,
  };
  return { deps, google, store };
}

test('GET: signed out is 401; feature unavailable says so; no request yet says none', async () => {
  assert.equal((await handleProvisionGet(getDeps({ getUser: async () => null }).deps)).status, 401);

  const off = await handleProvisionGet(getDeps({ loadState: async () => ({ available: false, row: null }) }).deps);
  assert.deepEqual(off.body, { ok: true, available: false, provision: null });

  const none = await handleProvisionGet(getDeps().deps);
  assert.deepEqual(none.body, { ok: true, available: true, provision: null });
});

test('GET: an open invitation is checked at Google, a finished one is only read', async () => {
  const { deps, google, store } = getDeps();
  const account = google.addAccount({ name: 'a', invitations: [{ email: 'ahmed.ali@gmail.com', status: 'PENDING' }] });
  store.seed({ user_id: USER.id, status: 'invited', customer_id: account.id, invited_email: 'ahmed.ali@gmail.com' });

  google.accept(account.id, 'ahmed.ali@gmail.com');
  const accepted = await handleProvisionGet(deps);
  assert.equal((accepted.body.provision as any).status, 'accepted');

  const calls = google.calls.length;
  const again = await handleProvisionGet(deps);
  assert.equal((again.body.provision as any).status, 'accepted');
  assert.equal(google.calls.length, calls, 'an accepted request with the unlink flag off is not looked at again');
});

test('GET: a Google fault does not break the poll; the stored state is returned', async () => {
  const { deps, store } = getDeps({
    loadAds: async () => {
      throw new Error('token cannot be decrypted');
    },
  });
  store.seed({ user_id: USER.id, status: 'invited', customer_id: '5550000009', invited_email: 'ahmed.ali@gmail.com' });
  const result = await handleProvisionGet(deps);
  assert.equal(result.status, 200);
  assert.equal((result.body.provision as any).status, 'invited');
});

test('POST: an auth outage is 503 and touches nothing; GET quietly says unavailable', async () => {
  const post = postDeps({
    getUser: async () => {
      throw new Error('auth down');
    },
  });
  const a = await handleProvisionPost(post.deps);
  assert.equal(a.status, 503);
  assert.equal(post.google.calls.length, 0);

  const get = await handleProvisionGet(
    getDeps({
      getUser: async () => {
        throw new Error('auth down');
      },
    }).deps
  );
  assert.deepEqual(get.body, { ok: true, available: false, provision: null });
});

test('GET: a request stuck in creating is released for a retry once it is stale, a fresh one is left alone', async () => {
  const old = new MemoryStore(() => new Date(Date.now() - 20 * 60 * 1000));
  const stuck = getDeps({ store: old, loadState: async (user) => ({ available: true, row: await old.get(user.id) }) });
  old.seed({ user_id: USER.id, status: 'creating', customer_id: null });
  const a = await handleProvisionGet(stuck.deps);
  assert.deepEqual(a.body.provision, { status: 'failed', invitedEmail: 'user@gmail.com', canRetry: true });
  assert.equal(old.rows.get(USER.id)!.error_code, 'CREATE_UNCONFIRMED');

  const fresh = new MemoryStore();
  const quick = getDeps({ store: fresh, loadState: async (user) => ({ available: true, row: await fresh.get(user.id) }) });
  fresh.seed({ user_id: USER.id, status: 'creating' });
  const b = await handleProvisionGet(quick.deps);
  assert.equal((b.body.provision as any).status, 'creating');
});

test('GET: the manager token is not even loaded when this poll will not look at Google', async () => {
  let loads = 0;
  const { deps, store } = getDeps({
    loadAds: async () => {
      loads += 1;
      return null;
    },
  });
  store.seed({ user_id: USER.id, status: 'invited', customer_id: '5550000009', last_checked_at: new Date().toISOString() });
  const recent = await handleProvisionGet(deps);
  assert.equal((recent.body.provision as any).status, 'invited');
  assert.equal(loads, 0, 'checked a moment ago: no decrypt, no Google');

  store.rows.get(USER.id)!.last_checked_at = new Date(Date.now() - 60_000).toISOString();
  await handleProvisionGet(deps);
  assert.equal(loads, 1);

  store.rows.get(USER.id)!.status = 'failed';
  await handleProvisionGet(deps);
  assert.equal(loads, 1, 'a finished or failed row never loads it');
});
