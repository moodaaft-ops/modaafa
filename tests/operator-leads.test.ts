import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgencyViews, buildLeadViews, leadWhatsappText, loadLeadsDataset } from '../lib/platform/operator-leads';

const rule = { agencyLeadMinSpendBand: '10k_30k' as const, agencyLeadManagers: ['nobody'] as const };
const users = new Map<string, any>([
  ['u1', { id: 'u1', email: 'a@x.com', name: 'علي', phone: '0501234567', created_at: '2026-10-12T10:00:00Z' }],
  ['u2', { id: 'u2', email: 'b@x.com', name: null, phone: null, created_at: '2026-10-13T10:00:00Z' }],
  ['u3', { id: 'u3', email: 'c@x.com', name: null, phone: null, created_at: '2026-10-11T10:00:00Z' }],
]);
const answers = [
  { user_id: 'u1', business_type: 'ecommerce', spend_band: 'over_30k', account_manager: 'nobody', skipped: false },
  { user_id: 'u2', business_type: 'other', spend_band: '10k_30k', account_manager: 'nobody', skipped: false },
  { user_id: 'u3', business_type: 'other', spend_band: 'over_30k', account_manager: 'agency', skipped: false },
  { user_id: 'u4', business_type: null, spend_band: null, account_manager: null, skipped: true },
  { user_id: 'ghost', business_type: 'other', spend_band: 'over_30k', account_manager: 'nobody', skipped: false },
];

test('agency leads: only the rule matches, newest sign-up first, skips and unknown users dropped', () => {
  const views = buildAgencyViews(answers, users, rule);
  assert.deepEqual(views.map((v) => v.userId), ['u2', 'u1']);
});

test('agency leads: empty while the owner has not picked a band', () => {
  assert.deepEqual(buildAgencyViews(answers, users, { agencyLeadMinSpendBand: null, agencyLeadManagers: ['nobody'] }), []);
});

test('lead views show the contact, and flag an email that already has an account', () => {
  const rows = [
    { id: 'L1', channel: 'email', email: 'a@x.com', whatsapp: null, source: 'exit_desktop', created_at: 't', followup_status: 'pending', whatsapp_status: 'pending', messages_opt_out: false },
    { id: 'L2', channel: 'whatsapp', email: null, whatsapp: '966501234567', source: 'exit_mobile', created_at: 't', followup_status: 'pending', whatsapp_status: 'pending', messages_opt_out: false },
  ];
  const views = buildLeadViews(rows, new Set(['a@x.com']));
  assert.equal(views[0].contact, 'a@x.com');
  assert.equal(views[0].alreadyUser, true);
  assert.equal(views[1].contact, '966501234567');
  assert.equal(views[1].alreadyUser, false);
});

test('the WhatsApp text ends with the sample link on its own line, when there is one', () => {
  assert.match(leadWhatsappText('https://example.com/s'), /\nhttps:\/\/example\.com\/s$/);
  assert.doesNotMatch(leadWhatsappText(null), /https/);
});

test('missing tables are reported, not thrown', async () => {
  const client = { from: () => { const b: any = { select: () => b, order: () => b, limit: async () => ({ data: null, error: { code: '42P01', message: 'x' } }), in: () => b }; return b; } };
  const dataset = await loadLeadsDataset({ client });
  assert.equal(dataset.leadsUnavailable, true);
  assert.equal(dataset.agencyUnavailable, true);
  assert.deepEqual(dataset.leads, []);
  assert.deepEqual(dataset.agency, []);
});
