import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACCOUNT_MANAGERS,
  BUSINESS_TYPES,
  SPEND_BANDS,
  isAgencyLead,
  parseOnboardingAnswers,
  spendBandMin,
} from '../lib/growth/onboarding-answers';
import { loadAnswers, rowToState, saveAnswers } from '../lib/growth/answers-store';

const sql = readFileSync(resolve('db/migrations/20261014_user_onboarding_answers.sql'), 'utf8');

function listFromSql(column: string) {
  const block = sql.match(new RegExp(`${column} text check \\(${column} in \\(([\\s\\S]*?)\\)\\)`, 'i'))?.[1] ?? '';
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

test('the SQL CHECK lists match the option lists in code, in the same order', () => {
  assert.deepEqual(listFromSql('business_type'), BUSINESS_TYPES.map((o) => o.key));
  assert.deepEqual(listFromSql('spend_band'), SPEND_BANDS.map((o) => o.key));
  assert.deepEqual(listFromSql('account_manager'), ACCOUNT_MANAGERS.map((o) => o.key));
});

test('the answers table is server-only and tied to the user', () => {
  assert.match(sql, /references public\.users \(id\) on delete cascade/i);
  assert.match(sql, /alter table public\.user_onboarding_answers enable row level security/i);
  assert.match(sql, /revoke all on table public\.user_onboarding_answers from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant select, insert, update on table public\.user_onboarding_answers to service_role/i);
  assert.doesNotMatch(sql, /create policy/i);
});

test('parseOnboardingAnswers accepts exactly the listed values', () => {
  const ok = parseOnboardingAnswers({ businessType: 'ecommerce', spendBand: '10k_30k', accountManager: 'nobody' });
  assert.deepEqual(ok, { ok: true, skipped: false, answers: { businessType: 'ecommerce', spendBand: '10k_30k', accountManager: 'nobody' } });
  assert.deepEqual(parseOnboardingAnswers({ skip: true }), { ok: true, skipped: true });
});

test('parseOnboardingAnswers refuses anything else', () => {
  assert.equal(parseOnboardingAnswers(null).ok, false);
  assert.equal(parseOnboardingAnswers('x').ok, false);
  assert.equal((parseOnboardingAnswers({ spendBand: '10k_30k', accountManager: 'self' }) as any).error, 'invalid_business_type');
  assert.equal((parseOnboardingAnswers({ businessType: 'ecommerce', spendBand: '1000000', accountManager: 'self' }) as any).error, 'invalid_spend_band');
  assert.equal((parseOnboardingAnswers({ businessType: 'ecommerce', spendBand: 'under_3k', accountManager: "self'; drop table users;--" }) as any).error, 'invalid_account_manager');
  // A user id in the body is ignored: the route takes it from the session only.
  const withId = parseOnboardingAnswers({ userId: 'someone-else', businessType: 'other', spendBand: 'unknown', accountManager: 'agency' }) as any;
  assert.equal(withId.ok, true);
  assert.equal('userId' in withId.answers, false);
});

test('skip:"true" as a string is not a skip', () => {
  assert.equal(parseOnboardingAnswers({ skip: 'true' }).ok, false);
});

test('agency lead: hidden while the owner has not picked a band', () => {
  assert.equal(isAgencyLead({ spendBand: 'over_30k', accountManager: 'nobody' }, { agencyLeadMinSpendBand: null, agencyLeadManagers: ['nobody'] }), false);
});

test('agency lead: spend at or above the band AND a listed manager state', () => {
  const rule = { agencyLeadMinSpendBand: '10k_30k' as const, agencyLeadManagers: ['nobody'] as const };
  assert.equal(isAgencyLead({ spendBand: '10k_30k', accountManager: 'nobody' }, rule), true);
  assert.equal(isAgencyLead({ spendBand: 'over_30k', accountManager: 'nobody' }, rule), true);
  assert.equal(isAgencyLead({ spendBand: '3k_10k', accountManager: 'nobody' }, rule), false);
  assert.equal(isAgencyLead({ spendBand: 'over_30k', accountManager: 'agency' }, rule), false);
  assert.equal(isAgencyLead({ spendBand: 'over_30k', accountManager: 'self' }, rule), false);
  // "I don't know" has no edge, so it never counts, even for the lowest threshold.
  assert.equal(isAgencyLead({ spendBand: 'unknown', accountManager: 'nobody' }, { ...rule, agencyLeadMinSpendBand: 'under_3k' }), false);
  assert.equal(isAgencyLead(null, rule), false);
});

test('agency lead: the owner can widen the manager list', () => {
  const rule = { agencyLeadMinSpendBand: 'over_30k' as const, agencyLeadManagers: ['nobody', 'self'] as const };
  assert.equal(isAgencyLead({ spendBand: 'over_30k', accountManager: 'self' }, rule), true);
});

test('spendBandMin follows the listed edges', () => {
  assert.equal(spendBandMin('under_3k'), 0);
  assert.equal(spendBandMin('3k_10k'), 3000);
  assert.equal(spendBandMin('over_30k'), 30000);
  assert.equal(spendBandMin('unknown'), null);
  assert.equal(spendBandMin('nonsense'), null);
});

test('rowToState maps rows and treats a half-filled row as unanswered', () => {
  assert.deepEqual(rowToState(null), { status: 'none' });
  assert.deepEqual(rowToState({ business_type: null, spend_band: null, account_manager: null, skipped: true }), { status: 'skipped' });
  assert.deepEqual(rowToState({ business_type: 'other', spend_band: null, account_manager: 'self', skipped: false }), { status: 'none' });
  assert.deepEqual(
    rowToState({ business_type: 'education', spend_band: 'under_3k', account_manager: 'self', skipped: false }),
    { status: 'answered', answers: { businessType: 'education', spendBand: 'under_3k', accountManager: 'self' } }
  );
});

test('loadAnswers answers "unavailable" when the table is missing or the read throws', async () => {
  const missing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'no table' } }) }) }) }) };
  assert.deepEqual(await loadAnswers('u1', { client: missing }), { status: 'unavailable' });
  const boom = { from: () => { throw new Error('down'); } };
  assert.deepEqual(await loadAnswers('u1', { client: boom }), { status: 'unavailable' });
});

test('saveAnswers upserts one row per user and a skip clears the answers', async () => {
  const calls: any[] = [];
  const client = { from: (t: string) => ({ upsert: async (row: any, opts: any) => { calls.push({ t, row, opts }); return { error: null }; } }) };
  const now = () => new Date('2026-10-14T10:00:00Z');
  await saveAnswers('u1', { skipped: false, answers: { businessType: 'ecommerce', spendBand: '3k_10k', accountManager: 'self' } }, { client, now });
  await saveAnswers('u1', { skipped: true }, { client, now });
  assert.equal(calls[0].t, 'user_onboarding_answers');
  assert.deepEqual(calls[0].opts, { onConflict: 'user_id' });
  assert.equal(calls[0].row.skipped, false);
  assert.equal(calls[1].row.skipped, true);
  assert.equal(calls[1].row.business_type, null);
  const failing = { from: () => ({ upsert: async () => ({ error: { code: '42P01', message: 'x' } }) }) };
  assert.deepEqual(await saveAnswers('u1', { skipped: true }, { client: failing }), { ok: false });
});
