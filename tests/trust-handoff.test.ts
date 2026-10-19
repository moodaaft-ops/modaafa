import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ownerConfig } from '../lib/landing/owner-config';
import { evaluateStoredHandoff } from '../lib/handoff/read';
import {
  DEFAULT_HANDOFF_THRESHOLDS,
  HANDOFF_CARD_COPY,
  detectHandoff,
  handoffWhatsappUrl,
  type HandoffInput,
} from '../lib/handoff/rules';
import { spend30dFromSnapshot } from '../lib/handoff/signals';
import { agencyHandoffEnabled } from '../lib/handoff/flag';
import { recordHandoffRequest, refreshHandoff } from '../lib/handoff/store';
import { SUPPORT_WHATSAPP_NUMBER } from '../lib/support/contact';

const quiet: HandoffInput = { spend30dSar: 1000, suspended: false, googleDisabled: false, policyFlaggedAds: 0, askedForHuman: false };
const T = { monthlySpendThresholdSar: 10000, policyFlaggedAdsThreshold: 3 };

test('flag is off unless exactly true; default thresholds come from the owner config', () => {
  assert.equal(agencyHandoffEnabled({} as any), false);
  assert.equal(agencyHandoffEnabled({ AGENCY_HANDOFF_ENABLED: 'yes' } as any), false);
  assert.equal(agencyHandoffEnabled({ AGENCY_HANDOFF_ENABLED: 'true' } as any), true);
  assert.equal(DEFAULT_HANDOFF_THRESHOLDS, ownerConfig.handoff);
  assert.ok((ownerConfig.handoff.monthlySpendThresholdSar ?? 0) > 0);
});

test('a quiet account does not need the team', () => {
  assert.deepEqual(detectHandoff(quiet, T), { needed: false, reasons: [] });
});

test('spend rule: strictly above the line fires, at the line does not, unknown never fires', () => {
  assert.equal(detectHandoff({ ...quiet, spend30dSar: 10000 }, T).needed, false);
  const over = detectHandoff({ ...quiet, spend30dSar: 10001 }, T);
  assert.equal(over.needed, true);
  assert.equal(over.reasons[0].code, 'spend_over_threshold');
  assert.equal(detectHandoff({ ...quiet, spend30dSar: null }, T).needed, false);
  assert.equal(detectHandoff({ ...quiet, spend30dSar: 1e9 }, { ...T, monthlySpendThresholdSar: null }).needed, false);
});

test('suspension: an operator suspension or a Google-disabled account', () => {
  assert.deepEqual(detectHandoff({ ...quiet, suspended: true }, T).reasons.map((r) => r.code), ['suspended']);
  assert.deepEqual(detectHandoff({ ...quiet, googleDisabled: true }, T).reasons.map((r) => r.code), ['suspended']);
});

test('policy rule needs several flagged ads, unknown never fires', () => {
  assert.equal(detectHandoff({ ...quiet, policyFlaggedAds: 2 }, T).needed, false);
  assert.equal(detectHandoff({ ...quiet, policyFlaggedAds: 3 }, T).needed, true);
  assert.equal(detectHandoff({ ...quiet, policyFlaggedAds: null }, T).needed, false);
});

test('asking for a human always fires, and several reasons are all listed', () => {
  assert.deepEqual(detectHandoff({ ...quiet, askedForHuman: true }, T).reasons.map((r) => r.code), ['asked_for_human']);
  const all = detectHandoff({ spend30dSar: 99999, suspended: true, googleDisabled: false, policyFlaggedAds: 9, askedForHuman: true }, T);
  assert.deepEqual(all.reasons.map((r) => r.code), ['spend_over_threshold', 'suspended', 'repeated_policy', 'asked_for_human']);
});

test('WhatsApp link goes to the support number with the summary, and the copy follows the house rules', () => {
  const verdict = detectHandoff({ ...quiet, spend30dSar: 25000, askedForHuman: true }, T);
  const url = handoffWhatsappUrl({ accountName: 'مكيفات الرياض', customerId: '123-456-7890', reasons: verdict.reasons, spend30dSar: 25000 });
  assert.ok(url.startsWith(`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=`));
  const text = decodeURIComponent(url.split('?text=')[1]);
  assert.match(text, /مكيفات الرياض/);
  assert.match(text, /25,000 ريال/);
  const copy = [HANDOFF_CARD_COPY.title, HANDOFF_CARD_COPY.body, HANDOFF_CARD_COPY.button, text, ...verdict.reasons.map((r) => r.text_ar)].join('\n');
  assert.equal(HANDOFF_CARD_COPY.title, 'خلّ فريق مُضاعفة يمسكه');
  assert.doesNotMatch(copy, /[–—]/);
  assert.doesNotMatch(copy, /[؀-ۿ],/);
});

test('a bad account name or id cannot inject lines into the message', () => {
  const url = handoffWhatsappUrl({ accountName: 'x\n‮evil', customerId: '12; DROP', reasons: [] });
  const text = decodeURIComponent(url.split('?text=')[1]);
  assert.equal(text.split('\n').length, 2);
  assert.doesNotMatch(text, /DROP/);
});

test('stored row: suspension and the merchant request are read live, spend from the row', () => {
  const row = { account_id: 'a', spend_30d_sar: '30000', policy_flagged_ads: 0, evaluated_at: 'x', asked_at: null, handled_at: null };
  assert.equal(evaluateStoredHandoff(row, { suspended: false, googleDisabled: false }, T).needed, true);
  assert.equal(evaluateStoredHandoff(null, { suspended: true, googleDisabled: false }, T).needed, true);
  assert.equal(evaluateStoredHandoff(null, { suspended: false, googleDisabled: false }, T).needed, false);
  const asked = { ...row, spend_30d_sar: 5, asked_at: '2026-10-19T00:00:00Z' };
  assert.equal(evaluateStoredHandoff(asked, { suspended: false, googleDisabled: false }, T).needed, true);
  assert.equal(evaluateStoredHandoff({ ...asked, handled_at: '2026-10-19T01:00:00Z' }, { suspended: false, googleDisabled: false }, T).needed, false);
});

test('spend is read from the snapshot campaign rows', () => {
  const snapshot = {
    campaigns: [
      { campaign: { resource_name: 'customers/1/campaigns/1', name: 'a' }, last_30d: { cost_micros: 4_000_000_000, conversions: 1, conversions_value: 0 } },
      { campaign: { resource_name: 'customers/1/campaigns/2', name: 'b' }, last_30d: { cost_micros: 1_500_000_000, conversions: 0, conversions_value: 0 } },
      { campaign: { resource_name: 'customers/1/campaigns/3', name: 'c' } },
    ],
  };
  assert.equal(spend30dFromSnapshot(snapshot), 5500);
  assert.equal(spend30dFromSnapshot({ campaigns: [] }), null);
});

function fakeAdmin() {
  const calls: Array<{ table: string; op: string; row?: any }> = [];
  const admin = {
    calls,
    from(table: string) {
      return {
        upsert: async (row: any) => (calls.push({ table, op: 'upsert', row }), { error: null }),
        insert: async (row: any) => (calls.push({ table, op: 'insert', row }), { error: null }),
        update: (row: any) => ({ eq: async () => (calls.push({ table, op: 'update', row }), { error: null }) }),
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    },
  };
  return admin;
}

test('refreshing never touches the merchant request columns', async () => {
  const admin = fakeAdmin();
  const verdict = await refreshHandoff({ admin, accountId: 'acc', input: { ...quiet, spend30dSar: 50000 }, thresholds: T });
  assert.equal(verdict?.needed, true);
  const row = admin.calls[0].row;
  assert.ok(!('asked_at' in row) && !('handled_at' in row));
  assert.deepEqual(row.reasons, ['spend_over_threshold']);
});

test('a failing refresh never throws into the optimizer', async () => {
  const admin = { from: () => ({ upsert: async () => { throw new Error('db down'); } }) };
  assert.equal(await refreshHandoff({ admin, accountId: 'acc', input: quiet }), null);
});

test('a merchant request creates the row when none exists', async () => {
  const admin = fakeAdmin();
  await recordHandoffRequest(admin, 'acc', new Date('2026-10-19T10:00:00Z'));
  assert.equal(admin.calls[0].op, 'insert');
  assert.equal(admin.calls[0].row.asked_at, '2026-10-19T10:00:00.000Z');
});

test('migration is idempotent and owner-readable only', () => {
  const sql = readFileSync(new URL('../db/migrations/20261020_trust_agency_handoff.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.agency_handoffs/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.agency_handoffs TO authenticated/);
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)/);
});
