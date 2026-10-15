import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MODAAFA_MCC_ID, ownManagerIdsFrom } from '../lib/setup/adaptive/signals';
import { isAccountProvisioning, provisioningMccId, unlinkAfterAcceptEnabled } from '../lib/provisioning/flag';
import { provisionView, type ProvisionRow } from '../lib/provisioning/types';

const OPERATORS = 'owner@modaafa.com, Second@Modaafa.com';

test('ACCOUNT_PROVISIONING: off by default, true for everyone, operators for operators plus the allowlist', () => {
  assert.equal(isAccountProvisioning({}, 'user@x.co'), false);
  assert.equal(isAccountProvisioning({ ACCOUNT_PROVISIONING: 'off' }, 'user@x.co'), false);
  assert.equal(isAccountProvisioning({ ACCOUNT_PROVISIONING: 'yes' }, 'user@x.co'), false, 'only the exact words count');
  assert.equal(isAccountProvisioning({ ACCOUNT_PROVISIONING: 'true' }, 'user@x.co'), true);
  assert.equal(isAccountProvisioning({ ACCOUNT_PROVISIONING: 'true' }, null), true);

  const operators = { ACCOUNT_PROVISIONING: 'operators', MODAAFA_OPERATOR_EMAILS: OPERATORS, ACCOUNT_PROVISIONING_ALLOWLIST: 'Tester@X.co' };
  assert.equal(isAccountProvisioning(operators, 'second@modaafa.com'), true);
  assert.equal(isAccountProvisioning(operators, 'tester@x.co'), true);
  assert.equal(isAccountProvisioning(operators, 'user@x.co'), false);
  assert.equal(isAccountProvisioning(operators, null), false);
  assert.equal(isAccountProvisioning({ ACCOUNT_PROVISIONING: 'operators' }, 'owner@modaafa.com'), false, 'no operator list, no operator');
});

test('PROVISIONING_MCC_ID must be ten digits; dashes are ignored; anything else is unset', () => {
  assert.equal(provisioningMccId({ PROVISIONING_MCC_ID: '123-456-7890' }), '1234567890');
  assert.equal(provisioningMccId({ PROVISIONING_MCC_ID: ' 1234567890 ' }), '1234567890');
  assert.equal(provisioningMccId({ PROVISIONING_MCC_ID: '12345' }), null);
  assert.equal(provisioningMccId({ PROVISIONING_MCC_ID: '' }), null);
  assert.equal(provisioningMccId({}), null);
});

test('the unlink flag is false unless it is exactly "true"', () => {
  assert.equal(unlinkAfterAcceptEnabled({}), false);
  assert.equal(unlinkAfterAcceptEnabled({ PROVISIONING_UNLINK_AFTER_ACCEPT: 'false' }), false);
  assert.equal(unlinkAfterAcceptEnabled({ PROVISIONING_UNLINK_AFTER_ACCEPT: '1' }), false);
  assert.equal(unlinkAfterAcceptEnabled({ PROVISIONING_UNLINK_AFTER_ACCEPT: 'true' }), true);
});

test('the smart reading treats the provisioning manager as ours, once it is configured', () => {
  const previous = process.env.PROVISIONING_MCC_ID;
  try {
    delete process.env.PROVISIONING_MCC_ID;
    assert.deepEqual(ownManagerIdsFrom(), [MODAAFA_MCC_ID]);
    process.env.PROVISIONING_MCC_ID = '123-456-7890';
    assert.deepEqual(ownManagerIdsFrom(), [MODAAFA_MCC_ID, '1234567890']);
    assert.deepEqual(ownManagerIdsFrom(['1234567890', '999-888-7777']), [MODAAFA_MCC_ID, '1234567890', '9998887777']);
  } finally {
    if (previous === undefined) delete process.env.PROVISIONING_MCC_ID;
    else process.env.PROVISIONING_MCC_ID = previous;
  }
});

test('the view the browser gets carries the state and the email, nothing else', () => {
  const row: ProvisionRow = {
    id: 'r1',
    user_id: 'u1',
    invited_email: 'a@b.co',
    account_name: 'a',
    customer_id: '5550000001',
    status: 'failed',
    error_code: 'USER_PERMISSION_DENIED',
    attempts: 2,
    created_at: '2026-10-15T10:00:00Z',
    invited_at: null,
    accepted_at: null,
    unlinked_at: null,
    last_checked_at: null,
    updated_at: '2026-10-15T10:00:00Z',
  };
  assert.deepEqual(provisionView(row), { status: 'failed', invitedEmail: 'a@b.co', canRetry: true });
  assert.deepEqual(provisionView({ ...row, status: 'invited' }), { status: 'invited', invitedEmail: 'a@b.co', canRetry: false });
});

// ---------------------------------------------------------------------------
// The migration and the wiring are checked as text: they are not run here.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the migration locks both tables: RLS on, nothing for anon, the owner reads only their own row, credentials for nobody', () => {
  const sql = read('db/migrations/20261015_account_provisioning.sql');
  assert.match(sql, /alter table public\.ads_account_provisions enable row level security/i);
  assert.match(sql, /alter table public\.provisioning_credentials enable row level security/i);
  assert.match(sql, /revoke all on table public\.ads_account_provisions from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke all on table public\.provisioning_credentials from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant select on table public\.ads_account_provisions to authenticated/i);
  assert.match(sql, /using \(user_id = auth\.uid\(\)\)/i);
  assert.doesNotMatch(sql, /grant[^;]+provisioning_credentials[^;]+to (anon|authenticated)/i);
  assert.doesNotMatch(sql, /create policy[^;]+provisioning_credentials/i, 'no policy at all on the credentials table');
  assert.match(sql, /user_id uuid not null unique/i, 'one account per user, enforced by the database');
  assert.match(sql, /id smallint primary key default 1 check \(id = 1\)/i, 'exactly one credentials row');
  assert.match(sql, /^begin;/im);
  assert.match(sql, /^commit;/im);
});

test('schema.sql carries the same two tables', () => {
  const schema = read('db/schema.sql');
  assert.match(schema, /create table if not exists public\.ads_account_provisions/i);
  assert.match(schema, /create table if not exists public\.provisioning_credentials/i);
});

test('the OAuth callback hands provisioning states to their own handler before the normal connect', () => {
  const callback = read('app/api/auth/google-ads/callback/route.ts');
  const branch = callback.indexOf("purpose: 'provisioning_mcc'");
  const normal = callback.indexOf("purpose: 'google_ads_connect'");
  assert.ok(branch > 0 && normal > branch, 'the provisioning state is tried first, and a miss falls through to the normal connect');
  assert.match(callback, /handleProvisioningConnect/);
  assert.match(callback, /provisioningState\.result === 'user_mismatch'/);
});

test('the connect leg: operator only, a server-side state with no cookie fallback, token saved encrypted and never returned', () => {
  const connect = read('app/api/operations/provisioning/connect/route.ts');
  assert.match(connect, /isOperatorUser/);
  assert.match(connect, /purpose: 'provisioning_mcc'/);
  assert.doesNotMatch(connect, /cookies\.set/, 'no cookie fallback for this state');

  const callback = read('lib/provisioning/connect-callback.ts');
  assert.match(callback, /isOperatorUser\(input\.user\)/);
  assert.match(callback, /listAccessibleCustomers/);
  assert.match(callback, /verifyManagerAccess/);
  assert.match(callback, /saveProvisioningCredentials/);
  assert.doesNotMatch(callback, /console\.(log|warn|error)\([^)]*refreshToken/);

  const credentials = read('lib/provisioning/credentials.ts');
  assert.match(credentials, /refresh_token_encrypted: encrypt\(input\.refreshToken\)/);
  assert.match(credentials, /decrypt\(row\.refresh_token_encrypted\)/);
});

test('the hourly job is wired: a workflow slot at minute 9 and a route guarded by CRON_SECRET', () => {
  const workflow = read('.github/workflows/scheduled-jobs.yml');
  assert.match(workflow, /- cron: '9 \* \* \* \*'/);
  assert.match(workflow, /api\/cron\/provisioning/);
  assert.match(workflow, /github\.event\.schedule == '9 \* \* \* \*'/);

  const route = read('app/api/cron/provisioning/route.ts');
  assert.match(route, /hasValidCronAuthorization\(req\)/);
  assert.match(route, /skipped: 'not_configured'/);
});

test('the create request can never be retried by the request layer', () => {
  const client = read('lib/google-ads/client.ts');
  assert.match(client, /export async function googleAdsRest/);
  assert.match(client, /maxAttempts: requestedAttempts/);
  const google = read('lib/google-ads/provisioning.ts');
  assert.match(google, /maxAttempts: 1/);
});

test('the four WhatsApp entries show the tile when the feature is on, and the full-management card is untouched', () => {
  const chat = read('app/onboarding/setup/setup-chat.tsx');
  assert.equal((chat.match(/<ProvisionAccountTile/g) ?? []).length, 2, 'no_account and open_account docks');
  assert.equal((chat.match(/provisioning\.available \? \(/g) ?? []).length, 2);
  assert.match(chat, /label="كلمنا على الواتساب ونرتبه معك"/, 'the connect_retry tile keeps WhatsApp');

  assert.match(read('app/onboarding/connect/page.tsx'), /<ProvisionAccountTile/);
  assert.match(read('app/onboarding/ads-guide/page.tsx'), /<ProvisionAccountTile/);
  assert.match(read('app/onboarding/page.tsx'), /loadProvisioningInitial/);

  const cards = read('app/onboarding/setup/adaptive-cards.tsx');
  assert.doesNotMatch(cards, /ProvisionAccountTile/);
  assert.match(cards, /whatsappHelpUrl\('full_management'/);
});

test('the tile falls back to WhatsApp on every failure path and writes no long dashes', () => {
  const tile = read('app/onboarding/provision-account-tile.tsx');
  assert.match(tile, /whatsappHelpUrl\('no_ads_account'/);
  assert.match(tile, /if \(!available\) return whatsapp/);
  assert.doesNotMatch(tile, /[—–]/);
});
