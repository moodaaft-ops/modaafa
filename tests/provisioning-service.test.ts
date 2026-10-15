import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INVITE_MAX_AGE_MS,
  STALE_CREATING_MS,
  accountNameFromEmail,
  refreshIfStale,
  refreshProvision,
  startProvision,
  sweepProvisions,
  validateInviteEmail,
  type ProvisionDeps,
} from '../lib/provisioning/service';
import { FakeGoogle, MemoryStore, restError } from './fixtures/provisioning-fakes';

const T0 = Date.parse('2026-10-15T10:00:00Z');

function setup(options: { unlink?: boolean } = {}) {
  let clock = T0;
  const now = () => new Date(clock);
  const google = new FakeGoogle();
  const store = new MemoryStore(now);
  const deps: ProvisionDeps = { store, ads: google.context(), unlinkAfterAccept: options.unlink ?? false, now };
  return { google, store, deps, advance: (ms: number) => (clock += ms) };
}

const USER = { id: 'user-1', email: 'Ahmed.Ali@Gmail.com' };
const isCreate = (request: { path: string }) => request.path.endsWith(':createCustomerClient');
const isInvite = (request: { path: string }) => request.path.endsWith('/customerUserAccessInvitations:mutate');

test('the account name is the part of the email before the @, and the email is validated plainly', () => {
  assert.equal(accountNameFromEmail('Ahmed.Ali@gmail.com'), 'Ahmed.Ali');
  assert.equal(accountNameFromEmail('  x@y.co '), 'x');
  assert.equal(accountNameFromEmail('@nothing.co'), 'عميل مُضاعِف');
  assert.equal(accountNameFromEmail(`${'a'.repeat(120)}@y.co`).length, 80);

  assert.equal(validateInviteEmail(' Ahmed@Gmail.com '), 'ahmed@gmail.com');
  for (const bad of ['', 'plain', 'a@b', 'a b@c.co', 'a@b.c', '<x>@y.co', 'a,b@c.co', 'a@b.co;c@d.co', 42, null, undefined]) {
    assert.equal(validateInviteEmail(bad), null, String(bad));
  }
  assert.equal(validateInviteEmail(`${'a'.repeat(250)}@y.co`), null);
});

test('a first press creates the account, then invites the email, in that order, and the row ends invited', async () => {
  const { google, store, deps } = setup();
  const result = await startProvision(deps, USER);

  assert.ok(result.ok);
  assert.equal(result.created, true);
  assert.equal(result.row.status, 'invited');
  assert.equal(result.row.invited_email, 'ahmed.ali@gmail.com');
  assert.equal(result.row.account_name, 'ahmed.ali');
  assert.ok(result.row.customer_id);
  assert.ok(result.row.invited_at);
  assert.equal(result.row.error_code, null);

  assert.deepEqual(google.calls.filter((call) => isCreate(call) || isInvite(call)).map((call) => (isCreate(call) ? 'create' : 'invite')), ['create', 'invite']);
  const created = [...google.accounts.values()][0];
  assert.equal(created.name, 'ahmed.ali');
  assert.deepEqual(created.invitations, [{ email: 'ahmed.ali@gmail.com', status: 'PENDING' }]);
  assert.equal((await store.get(USER.id))?.customer_id, created.id);
});

test('pressing again, or from another tab, returns the same row and creates nothing', async () => {
  const { google, deps } = setup();
  await startProvision(deps, USER);
  const again = await startProvision(deps, USER, 'someone.else@gmail.com');

  assert.ok(again.ok);
  assert.equal(again.created, false);
  assert.equal(again.row.invited_email, 'ahmed.ali@gmail.com', 'the email of an existing request cannot be replaced');
  assert.equal(google.creates, 1);
  assert.equal(google.invites, 1);
});

test('two simultaneous presses make one account', async () => {
  const { google, deps } = setup();
  const [a, b] = await Promise.all([startProvision(deps, USER), startProvision(deps, USER)]);
  assert.ok(a.ok && b.ok);
  assert.equal(google.creates, 1);
  assert.equal(google.accounts.size, 1);
  assert.equal([a, b].filter((result) => result.ok && result.created).length, 1);
});

test('the invited email may be changed before the first press, and must be valid', async () => {
  const { google, deps } = setup();
  const bad = await startProvision(deps, USER, 'not an email');
  assert.deepEqual(bad, { ok: false, reason: 'bad_email' });
  assert.equal(google.calls.length, 0);

  const changed = await startProvision(deps, USER, 'Other.Person@Hotmail.com');
  assert.ok(changed.ok);
  assert.equal(changed.row.invited_email, 'other.person@hotmail.com');
  assert.equal(changed.row.account_name, 'other.person');
  assert.equal([...google.accounts.values()][0].name, 'other.person');
});

test('a user whose platform email is unusable cannot start without giving one', async () => {
  const { google, deps } = setup();
  assert.deepEqual(await startProvision(deps, { id: 'u2', email: null }), { ok: false, reason: 'bad_email' });
  assert.equal(google.calls.length, 0);
});

test('a refused create leaves a failed row with Google\'s code, and a retry may use another email and succeeds', async () => {
  const { google, deps } = setup();
  google.failNext(isCreate, restError(403, 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE'));
  const first = await startProvision(deps, USER);
  assert.ok(first.ok);
  assert.equal(first.row.status, 'failed');
  assert.equal(first.row.error_code, 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE');
  assert.equal(first.row.customer_id, null);
  assert.equal(google.invites, 0, 'no invitation without an account');

  const retry = await startProvision(deps, USER, 'fresh.address@gmail.com');
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'invited');
  assert.equal(retry.row.attempts, 2);
  assert.equal(retry.row.invited_email, 'fresh.address@gmail.com');
  assert.equal(google.creates, 2);
});

test('an invite that fails after a good create keeps the account; the retry only re-invites the SAME email and never creates again', async () => {
  const { google, deps } = setup();
  google.failNext(isInvite, restError(400, 'INVALID_USER_EMAIL_ADDRESS'));
  const first = await startProvision(deps, USER);
  assert.ok(first.ok);
  assert.equal(first.row.status, 'failed');
  assert.equal(first.row.error_code, 'INVALID_USER_EMAIL_ADDRESS');
  assert.ok(first.row.customer_id, 'the account id is saved the moment Google returns it');

  const retry = await startProvision(deps, USER, 'attacker.target@gmail.com');
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'invited');
  assert.equal(retry.row.invited_email, 'ahmed.ali@gmail.com', 'an existing account is never re-aimed at another email');
  assert.equal(google.creates, 1);
  const account = [...google.accounts.values()][0];
  assert.deepEqual(account.invitations.map((invitation) => invitation.email), ['ahmed.ali@gmail.com']);
});

test('a retry whose first invite actually went through does not send a second one', async () => {
  const { google, deps } = setup();
  google.failNext(isInvite, Object.assign(new Error('timeout'), { name: 'TimeoutError' }), { executes: true });
  const first = await startProvision(deps, USER);
  assert.ok(first.ok && first.row.status === 'failed');

  const retry = await startProvision(deps, USER);
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'invited');
  assert.equal(google.invites, 1, 'Google already had the invitation; the retry looked first');
});

test('a create that may have happened is not repeated blindly: the retry adopts the orphan account', async () => {
  const { google, deps } = setup();
  google.failNext(isCreate, restError(503), { executes: true });
  const first = await startProvision(deps, USER);
  assert.ok(first.ok);
  assert.equal(first.row.status, 'failed');
  assert.equal(first.row.error_code, 'CREATE_UNCONFIRMED');
  assert.equal(first.row.customer_id, null);
  assert.equal(google.accounts.size, 1);

  const retry = await startProvision(deps, USER);
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'invited');
  assert.equal(google.creates, 1, 'no second create');
  assert.equal(google.accounts.size, 1, 'no duplicate account');
  assert.equal(retry.row.customer_id, [...google.accounts.keys()][0]);
});

test('a create that really did not happen is retried with a fresh create', async () => {
  const { google, deps } = setup();
  google.failNext(isCreate, restError(503), { executes: false });
  const first = await startProvision(deps, USER);
  assert.ok(first.ok && first.row.error_code === 'CREATE_UNCONFIRMED');
  assert.equal(google.accounts.size, 0);

  const retry = await startProvision(deps, USER);
  assert.ok(retry.ok && retry.row.status === 'invited');
  assert.equal(google.creates, 2);
  assert.equal(google.accounts.size, 1);
});

test('an orphan that another row owns, or that someone was invited to, is not adopted', async () => {
  const { google, store, deps } = setup();
  const other = google.addAccount({ name: 'ahmed.ali' });
  store.seed({ user_id: 'user-2', customer_id: other.id, status: 'invited', account_name: 'ahmed.ali' });
  store.seed({ user_id: USER.id, status: 'failed', error_code: 'CREATE_UNCONFIRMED', account_name: 'ahmed.ali', invited_email: 'ahmed.ali@gmail.com' });

  const retry = await startProvision(deps, USER);
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'invited');
  assert.notEqual(retry.row.customer_id, other.id, 'the other user\'s account stays theirs');
  assert.equal(google.creates, 1);
});

test('when Google cannot be searched for the orphan, the marker is kept and nothing is created', async () => {
  const { google, store, deps } = setup();
  store.seed({ user_id: USER.id, status: 'failed', error_code: 'CREATE_UNCONFIRMED', account_name: 'ahmed.ali', invited_email: 'ahmed.ali@gmail.com' });
  google.failNext((request) => request.path.endsWith('/googleAds:search'), restError(503));
  const retry = await startProvision(deps, USER);
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'failed');
  assert.equal(retry.row.error_code, 'CREATE_UNCONFIRMED');
  assert.equal(google.creates, 0);
});

test('two retries racing for one failed row: only one wins the claim', async () => {
  const { google, store, deps } = setup();
  store.seed({ user_id: USER.id, status: 'failed', error_code: 'HTTP_400', account_name: 'ahmed.ali', invited_email: 'ahmed.ali@gmail.com' });
  const [a, b] = await Promise.all([startProvision(deps, USER), startProvision(deps, USER)]);
  assert.ok(a.ok && b.ok);
  assert.equal(google.creates, 1);
});

test('an account id that already belongs to another row is treated as unconfirmed, not saved twice', async () => {
  const { google, store, deps } = setup();
  const account = google.addAccount({ name: 'ahmed.ali' });
  // Another row already claims the id the next create will return.
  store.seed({ user_id: 'user-9', customer_id: String(Number(account.id) + 1), status: 'invited' });
  const result = await startProvision(deps, USER);
  assert.ok(result.ok);
  assert.equal(result.row.status, 'failed');
  assert.equal(result.row.error_code, 'CREATE_UNCONFIRMED');
});

test('refreshProvision: a pending invitation stays invited and records the look', async () => {
  const { deps, advance } = setup();
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  advance(60_000);
  const next = await refreshProvision(deps, started.row);
  assert.equal(next.status, 'invited');
  assert.equal(next.last_checked_at, new Date(T0 + 60_000).toISOString());
});

test('refreshProvision: acceptance marks accepted and, with the unlink flag off, releases nothing', async () => {
  const { google, deps } = setup({ unlink: false });
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  google.accept(started.row.customer_id!, 'ahmed.ali@gmail.com');

  const next = await refreshProvision(deps, started.row);
  assert.equal(next.status, 'accepted');
  assert.ok(next.accepted_at);
  assert.equal(google.unlinks, 0);
});

test('refreshProvision: with the unlink flag on, an accepted account is released once and the row says unlinked', async () => {
  const { google, deps } = setup({ unlink: true });
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  google.accept(started.row.customer_id!, 'ahmed.ali@gmail.com');

  const next = await refreshProvision(deps, started.row);
  assert.equal(next.status, 'unlinked');
  assert.ok(next.unlinked_at);
  assert.equal(google.unlinks, 1);
  assert.equal(google.accounts.get(started.row.customer_id!)!.link, 'INACTIVE');
});

test('an unlink never rests on the stored status alone: Google is asked again first', async () => {
  const { google, store, deps } = setup({ unlink: true });
  const account = google.addAccount({ name: 'x', invitations: [{ email: 'ahmed.ali@gmail.com', status: 'PENDING' }] });
  const stale = store.seed({ user_id: USER.id, status: 'accepted', customer_id: account.id, invited_email: 'ahmed.ali@gmail.com' });

  const next = await refreshProvision(deps, stale);
  assert.equal(next.status, 'accepted');
  assert.equal(next.error_code, 'UNLINK_NOT_ACCEPTED');
  assert.equal(google.unlinks, 0);
});

test('a refused unlink keeps the account accepted and writes Google\'s code on the row', async () => {
  const { google, deps } = setup({ unlink: true });
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  google.accept(started.row.customer_id!, 'ahmed.ali@gmail.com');
  google.failNext((request) => request.path.endsWith('/customerClientLinks:mutate'), restError(400, 'CANNOT_REMOVE_LAST_CLIENT_ACCOUNT_OWNER'));

  const next = await refreshProvision(deps, started.row);
  assert.equal(next.status, 'accepted');
  assert.equal(next.error_code, 'CANNOT_REMOVE_LAST_CLIENT_ACCOUNT_OWNER');
});

test('refreshProvision: expired and declined invitations end as expired', async () => {
  for (const status of ['EXPIRED', 'DECLINED'] as const) {
    const { google, deps } = setup();
    const started = await startProvision(deps, USER);
    assert.ok(started.ok);
    google.accounts.get(started.row.customer_id!)!.invitations[0].status = status;
    const next = await refreshProvision(deps, started.row);
    assert.equal(next.status, 'expired');
    assert.equal(next.error_code, status === 'EXPIRED' ? 'INVITE_EXPIRED' : 'INVITE_DECLINED');
  }
});

test('an invitation Google no longer lists is waited on, then written off after 31 days', async () => {
  const { google, deps, advance } = setup();
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  google.accounts.get(started.row.customer_id!)!.invitations = [];

  const early = await refreshProvision(deps, started.row);
  assert.equal(early.status, 'invited');
  assert.equal(early.error_code, 'INVITE_NOT_VISIBLE');

  advance(INVITE_MAX_AGE_MS + 1000);
  const late = await refreshProvision(deps, early);
  assert.equal(late.status, 'expired');
  assert.equal(late.error_code, 'INVITE_AGE');
});

test('a Google error while looking is written on the row and does not change the status', async () => {
  const { google, deps } = setup();
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  google.failNext((request) => request.path.endsWith('/googleAds:search'), restError(500));
  const next = await refreshProvision(deps, started.row);
  assert.equal(next.status, 'invited');
  assert.equal(next.error_code, 'HTTP_500');
});

test('refreshIfStale looks at Google at most every 30 seconds', async () => {
  const { google, deps, advance } = setup();
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  const before = google.calls.length;

  const quick = await refreshIfStale(deps, started.row);
  assert.equal(quick.status, 'invited');
  assert.equal(google.calls.length, before, 'checked just now: no request');

  advance(31_000);
  google.accept(started.row.customer_id!, 'ahmed.ali@gmail.com');
  const later = await refreshIfStale(deps, started.row);
  assert.equal(later.status, 'accepted');
  assert.ok(google.calls.length > before);

  const done = await refreshIfStale(deps, later);
  assert.equal(done.status, 'accepted', 'a finished row is returned as it is');
});

test('sweepProvisions fails stale creating rows, follows the open ones and counts what changed', async () => {
  const { google, store, deps, advance } = setup({ unlink: true });
  const accepted = await startProvision(deps, { id: 'u-a', email: 'a.one@gmail.com' });
  const pending = await startProvision(deps, { id: 'u-b', email: 'b.two@gmail.com' });
  const expired = await startProvision(deps, { id: 'u-c', email: 'c.three@gmail.com' });
  assert.ok(accepted.ok && pending.ok && expired.ok);
  google.accept(accepted.row.customer_id!, 'a.one@gmail.com');
  google.accounts.get(expired.row.customer_id!)!.invitations[0].status = 'EXPIRED';
  store.seed({ user_id: 'u-stuck', status: 'creating' });
  advance(STALE_CREATING_MS + 1000);

  const summary = await sweepProvisions(deps);
  assert.equal(summary.staleFailed, 1);
  assert.equal(summary.checked, 3);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.unlinked, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.errors, 0);
  assert.equal((await store.get('u-stuck'))?.status, 'failed');
  assert.equal((await store.get('u-stuck'))?.error_code, 'CREATE_UNCONFIRMED');
  assert.equal((await store.get('u-b'))?.status, 'invited');
});

test('one broken row does not stop the sweep', async () => {
  const { google, store, deps } = setup();
  const good = await startProvision(deps, { id: 'u-good', email: 'good.one@gmail.com' });
  assert.ok(good.ok);
  store.seed({ user_id: 'u-bad', status: 'invited', customer_id: '777', invited_email: 'bad@gmail.com' });
  const original = store.update.bind(store);
  store.update = async (id, patch) => {
    if (id === store.rows.get('u-bad')!.id) throw new Error('database fault');
    return original(id, patch);
  };
  google.accept(good.row.customer_id!, 'good.one@gmail.com');

  const summary = await sweepProvisions(deps, { concurrency: 1 });
  assert.equal(summary.errors, 1);
  assert.equal(summary.accepted, 1);
});

test('with the unlink flag off the sweep only follows invited rows', async () => {
  const { google, store, deps } = setup({ unlink: false });
  const account = google.addAccount({ name: 'x', access: ['x@gmail.com'] });
  store.seed({ user_id: 'u-acc', status: 'accepted', customer_id: account.id, invited_email: 'x@gmail.com' });
  const summary = await sweepProvisions(deps);
  assert.equal(summary.checked, 0);
  assert.equal(google.calls.length, 0);
});

test('a dropped connection or an unreadable answer on create is treated as maybe-created, never as a plain failure', async () => {
  for (const failure of [Object.assign(new TypeError('terminated'), {}), restError(200, 'BAD_BODY'), restError(408)]) {
    const { google, deps } = setup();
    google.failNext(isCreate, failure, { executes: true });
    const first = await startProvision(deps, USER);
    assert.ok(first.ok);
    assert.equal(first.row.error_code, 'CREATE_UNCONFIRMED', String(failure));

    const retry = await startProvision(deps, USER);
    assert.ok(retry.ok);
    assert.equal(retry.row.status, 'invited');
    assert.equal(google.creates, 1, 'the retry adopted the account instead of making a second');
  }
});

test('changing the email while a create is unconfirmed keeps the account name, so the orphan is still found', async () => {
  const { google, deps } = setup();
  google.failNext(isCreate, restError(503), { executes: true });
  const first = await startProvision(deps, USER);
  assert.ok(first.ok);
  assert.equal(first.row.error_code, 'CREATE_UNCONFIRMED');

  const retry = await startProvision(deps, USER, 'sara.other@gmail.com');
  assert.ok(retry.ok);
  assert.equal(retry.row.status, 'invited');
  assert.equal(retry.row.invited_email, 'sara.other@gmail.com');
  assert.equal(retry.row.account_name, 'ahmed.ali', 'the name the orphan was created under');
  assert.equal(google.creates, 1);
  assert.equal(google.accounts.size, 1);
});

test('Google saying the invitation is already out, or already accepted, is where we wanted to be', async () => {
  const pending = setup();
  pending.google.failNext(isInvite, restError(400, 'EMAIL_ADDRESS_ALREADY_HAS_PENDING_INVITATION'));
  const a = await startProvision(pending.deps, USER);
  assert.ok(a.ok);
  assert.equal(a.row.status, 'invited');
  assert.equal(a.row.error_code, null);

  const access = setup();
  access.google.failNext(isInvite, restError(400, 'EMAIL_ADDRESS_ALREADY_HAS_ACCESS'));
  const b = await startProvision(access.deps, USER);
  assert.ok(b.ok);
  assert.equal(b.row.status, 'accepted');

  const other = setup();
  other.google.failNext(isInvite, restError(400, 'INVALID_EMAIL_ADDRESS'));
  const c = await startProvision(other.deps, USER);
  assert.ok(c.ok);
  assert.equal(c.row.status, 'failed');
  assert.equal(c.row.error_code, 'INVALID_EMAIL_ADDRESS');
});

test('a stale copy of a row never overwrites a newer state', async () => {
  const { google, store, deps } = setup({ unlink: true });
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  const staleCopy = { ...started.row };
  google.accept(started.row.customer_id!, 'ahmed.ali@gmail.com');

  // Another worker already took the row all the way to unlinked.
  await store.update(started.row.id, { status: 'unlinked', unlinked_at: new Date(T0).toISOString() });

  const result = await refreshProvision(deps, staleCopy);
  assert.equal(result.status, 'unlinked');
  assert.equal((await store.get(USER.id))!.status, 'unlinked');
  assert.equal(google.unlinks, 0, 'the stale copy did not release anything');
});

test('simultaneous polls make one look at Google, not one each', async () => {
  const { google, deps, advance } = setup();
  const started = await startProvision(deps, USER);
  assert.ok(started.ok);
  advance(31_000);
  const searches = () => google.count((request) => request.path.endsWith('/googleAds:search'));
  const before = searches();

  const [a, b, c] = await Promise.all([refreshIfStale(deps, started.row), refreshIfStale(deps, started.row), refreshIfStale(deps, started.row)]);
  assert.equal(a.status, 'invited');
  assert.equal(b.status, 'invited');
  assert.equal(c.status, 'invited');
  assert.equal(searches() - before, 2, 'one check is two searches (access, then invitations)');
});
