import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProvisioningError,
  activeParentManagers,
  checkInvite,
  countActiveClients,
  createClientAccount,
  findUnclaimedAccount,
  inviteAdmin,
  isAmbiguousFailure,
  parseCustomerId,
  provisioningErrorCode,
  unlinkClient,
  verifyManagerAccess,
} from '../lib/google-ads/provisioning';
import { AGENCY_MCC_ID } from '../lib/provisioning/flag';
import { MODAAFA_MCC_ID } from '../lib/setup/adaptive/signals';
import { FakeGoogle, TEST_MCC, restError } from './fixtures/provisioning-fakes';

test('the agency manager id kept in the provisioning flag module is the same one the signals module knows', () => {
  assert.equal(AGENCY_MCC_ID, MODAAFA_MCC_ID);
});

test('createClientAccount sends one create request: SAR, Riyadh, the name, no email, a single attempt', async () => {
  const google = new FakeGoogle();
  const { customerId } = await createClientAccount(google.context(), 'ahmed');

  assert.match(customerId, /^\d+$/);
  assert.equal(google.calls.length, 1);
  const [request] = google.calls;
  assert.equal(request.path, `/customers/${TEST_MCC}:createCustomerClient`);
  assert.equal(request.method, 'POST');
  assert.equal(request.loginCustomerId, TEST_MCC);
  assert.equal(request.maxAttempts, 1, 'a create must never be retried by the request layer');
  assert.deepEqual(request.body, { customerClient: { descriptiveName: 'ahmed', currencyCode: 'SAR', timeZone: 'Asia/Riyadh' } });
  assert.ok(!JSON.stringify(request.body).includes('@'), 'the email never travels inside the create request');
});

test('createClientAccount maps Google refusals to a stable code and says they are not ambiguous', async () => {
  const google = new FakeGoogle();
  google.failNext((request) => request.path.endsWith(':createCustomerClient'), restError(403, 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE'));
  await assert.rejects(
    () => createClientAccount(google.context(), 'ahmed'),
    (error: unknown) => {
      assert.ok(error instanceof ProvisioningError);
      assert.equal(error.code, 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE');
      assert.equal(error.ambiguous, false);
      return true;
    }
  );
  assert.equal(google.accounts.size, 0);
});

test('createClientAccount marks a 5xx, a timeout and an answer without an id as ambiguous', async () => {
  for (const failure of [restError(503), Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
    const google = new FakeGoogle();
    google.failNext((request) => request.path.endsWith(':createCustomerClient'), failure, { executes: true });
    await assert.rejects(
      () => createClientAccount(google.context(), 'ahmed'),
      (error: unknown) => error instanceof ProvisioningError && error.ambiguous === true
    );
    assert.equal(google.accounts.size, 1, 'the fake did create the account before the answer was lost');
  }

  const noId = new FakeGoogle();
  const context = { mccId: TEST_MCC, transport: async () => ({}) as any };
  await assert.rejects(
    () => createClientAccount(context, 'ahmed'),
    (error: unknown) => error instanceof ProvisioningError && error.code === 'CREATE_NO_ID' && error.ambiguous === true
  );
  assert.equal(noId.calls.length, 0);
});

test('only a definite refusal from Google is "not created"; everything else may have been', () => {
  assert.equal(isAmbiguousFailure(restError(429, 'RESOURCE_EXHAUSTED')), false);
  assert.equal(isAmbiguousFailure(restError(500)), true);
  assert.equal(isAmbiguousFailure(restError(400, 'INVALID_ARGUMENT')), false);
  assert.equal(isAmbiguousFailure(restError(403, 'USER_PERMISSION_DENIED')), false);
  assert.equal(isAmbiguousFailure(restError(408)), true);
  assert.equal(isAmbiguousFailure(restError(200, 'BAD_BODY')), true, 'Google answered OK but we could not read it');
  assert.equal(isAmbiguousFailure(new TypeError('terminated')), true, 'the socket dropped while reading the answer');
  assert.equal(isAmbiguousFailure(new Error('something unexpected')), true);
  assert.equal(provisioningErrorCode(restError(400)), 'HTTP_400');
  assert.equal(provisioningErrorCode(Object.assign(new Error('x'), { name: 'AbortError' })), 'REQUEST_TIMEOUT');
});

test('inviteAdmin is its own request, role ADMIN, on the new account, with the manager as login customer', async () => {
  const google = new FakeGoogle();
  const account = google.addAccount({ name: 'ahmed' });
  await inviteAdmin(google.context(), account.id, ' Ahmed@Gmail.com ');

  const [request] = google.calls;
  assert.equal(request.path, `/customers/${account.id}/customerUserAccessInvitations:mutate`);
  assert.equal(request.loginCustomerId, TEST_MCC);
  assert.deepEqual(request.body, { operation: { create: { emailAddress: 'Ahmed@Gmail.com', accessRole: 'ADMIN' } } });
  assert.equal(account.invitations.length, 1);
});

test('checkInvite reads acceptance from customer_user_access and the rest from the invitation table', async () => {
  const google = new FakeGoogle();
  const ctx = google.context();
  const account = google.addAccount({ name: 'a' });

  assert.equal(await checkInvite(ctx, account.id, 'a@gmail.com'), 'unknown', 'neither table mentions the email');

  await inviteAdmin(ctx, account.id, 'a@gmail.com');
  assert.equal(await checkInvite(ctx, account.id, 'a@gmail.com'), 'pending');

  account.invitations[0].status = 'EXPIRED';
  assert.equal(await checkInvite(ctx, account.id, 'a@gmail.com'), 'expired');
  account.invitations[0].status = 'DECLINED';
  assert.equal(await checkInvite(ctx, account.id, 'a@gmail.com'), 'declined');

  google.accept(account.id, 'a@gmail.com');
  assert.equal(await checkInvite(ctx, account.id, 'a@gmail.com'), 'accepted');
});

test('checkInvite matches the accepted email the way Gmail does (dots, case, +tag)', async () => {
  const google = new FakeGoogle();
  const ctx = google.context();
  const account = google.addAccount({ name: 'a' });
  google.accept(account.id, 'john.doe@gmail.com');
  assert.equal(await checkInvite(ctx, account.id, 'JohnDoe+ads@gmail.com'), 'accepted');
  assert.equal(await checkInvite(ctx, account.id, 'someone.else@gmail.com'), 'unknown');
});

test('unlinkClient makes the link INACTIVE through the manager, and only for the account asked', async () => {
  const google = new FakeGoogle();
  const ctx = google.context();
  const mine = google.addAccount({ name: 'mine' });
  const other = google.addAccount({ name: 'other' });

  assert.equal(await unlinkClient(ctx, mine.id), 'unlinked');
  assert.equal(mine.link, 'INACTIVE');
  assert.equal(other.link, 'ACTIVE', 'a neighbour account is never touched');

  const mutation = google.calls.find((request) => request.path.endsWith('/customerClientLinks:mutate'))!;
  assert.equal(mutation.path, `/customers/${TEST_MCC}/customerClientLinks:mutate`);
  assert.equal(mutation.loginCustomerId, TEST_MCC);
  assert.deepEqual((mutation.body as any).operation.updateMask, 'status');
  assert.equal((mutation.body as any).operation.update.status, 'INACTIVE');

  assert.equal(await unlinkClient(ctx, mine.id), 'already_unlinked');
  assert.equal(google.unlinks, 1, 'the second call found the link already inactive and sent nothing');
});

test('unlinkClient reports a missing link and surfaces the refusal Google gives for a last owner', async () => {
  const google = new FakeGoogle();
  const ctx = google.context();
  await assert.rejects(() => unlinkClient(ctx, '9990000001'), (error: unknown) => error instanceof ProvisioningError && error.code === 'LINK_NOT_FOUND');

  const account = google.addAccount({ name: 'x' });
  google.failNext((request) => request.path.endsWith('/customerClientLinks:mutate'), restError(400, 'CANNOT_REMOVE_LAST_CLIENT_ACCOUNT_OWNER'));
  await assert.rejects(
    () => unlinkClient(ctx, account.id),
    (error: unknown) => error instanceof ProvisioningError && error.code === 'CANNOT_REMOVE_LAST_CLIENT_ACCOUNT_OWNER'
  );
  assert.equal(account.link, 'ACTIVE');
});

test('countActiveClients counts everything but canceled and closed, per status', async () => {
  const google = new FakeGoogle();
  google.addAccount({ name: 'a' });
  google.addAccount({ name: 'b' });
  google.addAccount({ name: 'c', status: 'CANCELED' });
  const counts = await countActiveClients(google.context());
  assert.equal(counts.active, 2);
  assert.deepEqual(counts.byStatus, { ENABLED: 2, CANCELED: 1 });
});

test('verifyManagerAccess says whether the id is a manager', async () => {
  const google = new FakeGoogle();
  const result = await verifyManagerAccess(google.context());
  assert.deepEqual(result, { manager: true, name: 'Test MCC' });
});

test('findUnclaimedAccount adopts exactly one untouched account with the exact name', async () => {
  const google = new FakeGoogle();
  const ctx = google.context();
  const orphan = google.addAccount({ name: 'ahmed' });
  google.addAccount({ name: 'sara' });

  assert.equal(await findUnclaimedAccount(ctx, 'ahmed', new Set()), orphan.id);
  assert.equal(await findUnclaimedAccount(ctx, 'ahmed', new Set([orphan.id])), null, 'an account some row already owns is not adopted');
  assert.equal(await findUnclaimedAccount(ctx, 'ahmed2', new Set()), null);
});

test('findUnclaimedAccount refuses an account somebody was already invited to or has access to, and ambiguous names', async () => {
  const google = new FakeGoogle();
  const ctx = google.context();
  const invited = google.addAccount({ name: 'omar', invitations: [{ email: 'other@gmail.com', status: 'PENDING' }] });
  assert.equal(await findUnclaimedAccount(ctx, 'omar', new Set()), null);
  invited.invitations = [];
  assert.equal(await findUnclaimedAccount(ctx, 'omar', new Set()), invited.id);
  invited.access.push('old.user@gmail.com');
  assert.equal(await findUnclaimedAccount(ctx, 'omar', new Set()), null, 'an account a former user accepted is never handed to a new one');

  const twins = new FakeGoogle();
  twins.addAccount({ name: 'twin' });
  twins.addAccount({ name: 'twin' });
  assert.equal(await findUnclaimedAccount(twins.context(), 'twin', new Set()), null, 'two candidates: do not guess');
});

test('nothing in the Google layer runs against the agency manager or a malformed id', async () => {
  const google = new FakeGoogle();
  const agency = google.context(AGENCY_MCC_ID);
  await assert.rejects(() => createClientAccount(agency, 'x'), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
  await assert.rejects(() => inviteAdmin(agency, '123456', 'a@b.co'), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
  await assert.rejects(() => checkInvite(agency, '123456', 'a@b.co'), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
  await assert.rejects(() => unlinkClient(agency, '123456'), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
  await assert.rejects(() => countActiveClients(agency), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
  await assert.rejects(() => verifyManagerAccess(agency), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
  await assert.rejects(() => createClientAccount(google.context('12-34'), 'x'), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_NOT_CONFIGURED');
  await assert.rejects(() => unlinkClient(google.context(), "1' OR '1'='1"), (e: unknown) => e instanceof ProvisioningError && e.code === 'BAD_CUSTOMER_ID');
  assert.equal(google.calls.length, 0, 'not one request left the process');
});

test('parseCustomerId reads the id out of a resource name', () => {
  assert.equal(parseCustomerId('customers/1234567890'), '1234567890');
  assert.equal(parseCustomerId('nope'), null);
  assert.equal(parseCustomerId(undefined), null);
});

test('activeParentManagers lists the active managers above the dedicated one, and says "unknown" when it cannot read', async () => {
  const google = new FakeGoogle();
  assert.deepEqual(await activeParentManagers(google.context()), []);

  google.parents = [AGENCY_MCC_ID];
  assert.deepEqual(await activeParentManagers(google.context()), [AGENCY_MCC_ID]);

  google.failNext((request) => request.path.endsWith('/googleAds:search'), restError(403, 'USER_PERMISSION_DENIED'));
  assert.equal(await activeParentManagers(google.context()), null);

  await assert.rejects(() => activeParentManagers(google.context(AGENCY_MCC_ID)), (e: unknown) => e instanceof ProvisioningError && e.code === 'MCC_IS_AGENCY');
});
