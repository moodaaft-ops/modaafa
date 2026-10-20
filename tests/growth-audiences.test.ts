import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sha256Hex, normalizeEmail, normalizePhoneE164, prepareCustomerMatchMembers, buildIngestRequests,
  uploadCustomerMatch, NO_TRANSPORT, CustomerMatchNotConfiguredError, CustomerMatchRefusedError, CUSTOMER_MATCH_POLICY_AR,
  type CustomerMatchTransport,
} from '../lib/audiences/customer-match';
import {
  validateCreateUserListParams, buildUserListOperation, validateAttachAudienceParams, buildAttachAudienceOperations,
} from '../lib/audiences/user-lists';
import {
  executeCreateUserList, executeAttachAudience, validateAttachAudience, executeAudienceRollback,
  CLOSE_USER_LIST_ROLLBACK, REMOVE_AUDIENCE_CRITERION_ROLLBACK,
} from '../lib/audiences/execute';
import { CID, P, makeCustomer } from './growth-fixtures';

// ---- normalization and hashing -------------------------------------------------

test('sha256 of a known value', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('emails are lowercased, trimmed, and gmail dots and plus tags are removed', () => {
  assert.equal(normalizeEmail('  Ali.Test@Example.COM '), 'ali.test@example.com');
  assert.equal(normalizeEmail('A.l.i+shop@gmail.com'), 'ali@gmail.com');
  assert.equal(normalizeEmail('not an email'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(undefined), null);
});

test('Saudi phones normalize to E.164, including Arabic digits; landlines and junk are dropped', () => {
  assert.equal(normalizePhoneE164('0501234567'), '+966501234567');
  assert.equal(normalizePhoneE164('501234567'), '+966501234567');
  assert.equal(normalizePhoneE164('966501234567'), '+966501234567');
  assert.equal(normalizePhoneE164('00966501234567'), '+966501234567');
  assert.equal(normalizePhoneE164('+966 50 123 4567'), '+966501234567');
  assert.equal(normalizePhoneE164('٠٥٠١٢٣٤٥٦٧'), '+966501234567');
  assert.equal(normalizePhoneE164('0112345678'), null);
  assert.equal(normalizePhoneE164('123'), null);
  assert.equal(normalizePhoneE164('+971501234567'), '+971501234567');
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `user${i}@example.com`, phone: `05${String(10000000 + i)}` }));

test('members are hashed from the normalized value, deduplicated, and counted', () => {
  const prepared = prepareCustomerMatchMembers([
    { email: 'A@x.com', phone: '0501234567' },
    { email: ' a@X.com', phone: '+966501234567' },
    { email: 'bad', phone: '' },
    { email: '', phone: '' },
  ]);
  assert.equal(prepared.usable, 1);
  assert.equal(prepared.dropped.duplicate, 1);
  assert.equal(prepared.dropped.no_identifier, 2);
  assert.equal(prepared.invalid.email, 1);
  assert.equal(prepared.members[0].email_sha256, sha256Hex('a@x.com'));
  assert.equal(prepared.members[0].phone_sha256, sha256Hex('+966501234567'));
  assert.equal(prepared.meets_minimum, false);
});

test('the minimum is 100 members', () => {
  assert.equal(prepareCustomerMatchMembers(rows(99)).meets_minimum, false);
  assert.equal(prepareCustomerMatchMembers(rows(100)).meets_minimum, true);
});

// ---- upload gating --------------------------------------------------------------

const opts = { customerId: CID, userListId: '55', consentConfirmed: true, termsConfirmed: true };

test('the upload is refused without consent, without terms, or with fewer than 100 members', () => {
  const members = prepareCustomerMatchMembers(rows(100)).members;
  assert.throws(() => buildIngestRequests(members, { ...opts, consentConfirmed: false }), (e: any) => e instanceof CustomerMatchRefusedError && e.code === 'consent_not_confirmed');
  assert.throws(() => buildIngestRequests(members, { ...opts, termsConfirmed: false }), (e: any) => e.code === 'terms_not_confirmed');
  assert.throws(() => buildIngestRequests(members.slice(0, 99), opts), (e: any) => e.code === 'too_few_members');
  assert.throws(() => buildIngestRequests(members, { ...opts, userListId: 'abc' }), (e: any) => e.code === 'bad_ids');
});

test('requests carry only hashes, are chunked at 10000, and validateOnly is passed through', () => {
  const members = prepareCustomerMatchMembers(rows(150)).members;
  const [one] = buildIngestRequests(members, { ...opts, validateOnly: true });
  assert.equal(one.validateOnly, true);
  assert.ok(!JSON.stringify(one).includes('@example.com'));
  assert.ok(!JSON.stringify(one).includes('+966'));
  const big = Array.from({ length: 10_001 }, (_, i) => ({ email_sha256: sha256Hex(`u${i}`) }));
  assert.equal(buildIngestRequests(big, opts).length, 2);
});

test('without a transport nothing is uploaded: the default throws not-configured', async () => {
  const members = prepareCustomerMatchMembers(rows(100)).members;
  await assert.rejects(() => uploadCustomerMatch(members, opts), CustomerMatchNotConfiguredError);
  await assert.rejects(() => NO_TRANSPORT.ingest({} as any), CustomerMatchNotConfiguredError);
});

test('with a transport every chunk is sent in order and request ids are collected', async () => {
  const seen: number[] = [];
  const transport: CustomerMatchTransport = { async ingest(r) { seen.push(r.audienceMembers.length); return { requestId: `r${seen.length}` }; } };
  const big = Array.from({ length: 10_050 }, (_, i) => ({ email_sha256: sha256Hex(`u${i}`) }));
  const out = await uploadCustomerMatch(big, opts, transport);
  assert.deepEqual(seen, [10_000, 50]);
  assert.deepEqual(out.request_ids, ['r1', 'r2']);
});

test('the policy notes are stated and mention that eligibility is not checked here', () => {
  assert.ok(CUSTOMER_MATCH_POLICY_AR.length >= 3);
  assert.ok(CUSTOMER_MATCH_POLICY_AR.join(' ').length > 100);
});

// ---- user list params -------------------------------------------------------------

test('website visitors list: a clean host rule, default 30 days, bounds enforced', () => {
  const ok = validateCreateUserListParams({ kind: 'website_visitors', name: 'زوار المتجر', url_contains: 'https://www.Shop.example.com/' });
  assert.ok(ok.ok);
  if (ok.ok && ok.value.kind === 'website_visitors') {
    assert.equal(ok.value.url_contains, 'shop.example.com');
    assert.equal(ok.value.lookback_days, 30);
  }
  assert.equal(validateCreateUserListParams({ kind: 'website_visitors', name: 'x', url_contains: 'nodot' }).ok, false);
  assert.equal(validateCreateUserListParams({ kind: 'website_visitors', name: 'x', url_contains: 'a.com', lookback_days: 541 }).ok, false);
  assert.equal(validateCreateUserListParams({ kind: 'website_visitors', name: '', url_contains: 'a.com' }).ok, false);
});

test('customer match list requires the merchant consent confirmation', () => {
  assert.equal(validateCreateUserListParams({ kind: 'customer_match', name: 'عملائي' }).ok, false);
  assert.equal(validateCreateUserListParams({ kind: 'customer_match', name: 'عملائي', consent_confirmed: 'true' }).ok, false);
  assert.equal(validateCreateUserListParams({ kind: 'customer_match', name: 'عملائي', consent_confirmed: true }).ok, true);
});

test('the website list operation uses a rule on the url and a lifespan', () => {
  const op: any = buildUserListOperation({ kind: 'website_visitors', name: 'n', url_contains: 'shop.example.com', lookback_days: 30 });
  const create = op.user_list_operation.create;
  assert.equal(create.membership_status, 'OPEN');
  assert.equal(create.membership_life_span, 30);
  assert.ok(JSON.stringify(create).includes('shop.example.com'));
});

test('attach params are scoped to the account and targeting only', () => {
  const good = { ad_group_resource: `${P}/adGroups/1`, user_list_resource: `${P}/userLists/2` };
  assert.equal(validateAttachAudienceParams(good, CID).ok, true);
  assert.equal(validateAttachAudienceParams({ ...good, user_list_resource: 'customers/999/userLists/2' }, CID).ok, false);
  assert.equal(validateAttachAudienceParams({ ...good, mode: 'exclude' }, CID).ok, false);
  const ops: any[] = buildAttachAudienceOperations(validateAttachAudienceParams(good, CID).ok ? { ...good, mode: 'target' } : (null as any), CID, 'جمهور');
  assert.equal(ops.length, 2);
  assert.ok(ops[0].audience_operation);
  assert.ok(ops[1].ad_group_criterion_operation);
});

// ---- execution --------------------------------------------------------------------

test('create list: validateOnly, live, readback, and a close-list rollback', async () => {
  const stub = makeCustomer(
    [
      { match: /WHERE user_list\.name =/, rows: [] },
      { match: /user_list\.resource_name = /, rows: [{ userList: { resourceName: `${P}/userLists/21`, name: 'زوار المتجر', membershipStatus: 'OPEN' } }] },
    ],
    { mutateNames: () => [`${P}/userLists/21`] }
  );
  const result = await executeCreateUserList({ kind: 'website_visitors', name: 'زوار المتجر', url_contains: 'shop.example.com', lookback_days: 30 }, stub, CID);
  assert.deepEqual(stub.mutates.map((m: any) => m.validateOnly), [true, false]);
  assert.equal(result.readback.ok, true);
  assert.equal(result.rollback_payload.action_type, CLOSE_USER_LIST_ROLLBACK);
  await executeAudienceRollback(result.rollback_payload, stub);
  const last = stub.mutates[stub.mutates.length - 1].ops[0].user_list_operation.update;
  assert.equal(last.membership_status, 'CLOSED');
});

test('create list: an existing list with the same name is not created twice', async () => {
  const stub = makeCustomer([{ match: /WHERE user_list\.name =/, rows: [{ userList: { resourceName: `${P}/userLists/1` } }] }]);
  await assert.rejects(() => executeCreateUserList({ kind: 'website_visitors', name: 'x', url_contains: 'a.com', lookback_days: 30 }, stub, CID), /already exists/);
  assert.equal(stub.mutates.length, 0);
});

const attachHandlers = (size: number, grouped = true, channel = 'DEMAND_GEN') => [
  { match: /FROM ad_group WHERE ad_group\.resource_name/, rows: [{ adGroup: { status: 'ENABLED', audienceSetting: { useAudienceGrouped: grouped } }, campaign: { advertisingChannelType: channel } }] },
  { match: /FROM user_list WHERE user_list\.resource_name/, rows: [{ userList: { membershipStatus: 'OPEN', sizeForDisplay: size } }] },
  { match: /FROM ad_group_criterion WHERE/, rows: [{ adGroupCriterion: { type: 'AUDIENCE' } }] },
];
const attach = { ad_group_resource: `${P}/adGroups/1`, user_list_resource: `${P}/userLists/2` };

test('attach: needs a Demand Gen group with grouped audiences and a list of 100 or more', async () => {
  const names = (ops: any[]) => ops.map((_, i) => (i === 0 ? `${P}/audiences/8` : `${P}/adGroupCriteria/1~9`));
  const ok = makeCustomer(attachHandlers(500), { mutateNames: names });
  const result = await executeAttachAudience(attach, ok, CID, () => 'n');
  assert.equal(result.readback.ok, true);
  assert.equal(result.rollback_payload.action_type, REMOVE_AUDIENCE_CRITERION_ROLLBACK);
  assert.deepEqual(ok.mutates.map((m: any) => m.validateOnly), [true, false]);
  await executeAudienceRollback(result.rollback_payload, ok);
  assert.equal(ok.mutates[ok.mutates.length - 1].ops[0].ad_group_criterion_operation.remove, `${P}/adGroupCriteria/1~9`);

  await assert.rejects(() => executeAttachAudience(attach, makeCustomer(attachHandlers(40)), CID, () => 'n'), /fewer than 100/);
  await assert.rejects(() => executeAttachAudience(attach, makeCustomer(attachHandlers(500, false)), CID, () => 'n'), /grouped/);
  await assert.rejects(() => executeAttachAudience(attach, makeCustomer(attachHandlers(500, true, 'SEARCH')), CID, () => 'n'), /Demand Gen/);
  const v = makeCustomer(attachHandlers(500));
  await validateAttachAudience(attach, v, CID, () => 'n');
  assert.ok(v.mutates.every((m: any) => m.validateOnly));
});
