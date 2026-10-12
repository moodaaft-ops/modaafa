import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLeadOptOutUrl, buildOptOutUrl, verifyLeadOptOutToken, verifyOptOutToken } from '../lib/messaging/opt-out';
import { renderLeadFollowup, sendDueLeadFollowups, sendLeadFollowup } from '../lib/leads/followup';
import { exitPopupEnabled } from '../lib/growth/owner-config';
import { LEAD_FOLLOWUP } from '../config/lead-followup';

process.env.UNSUBSCRIBE_SECRET = 'test-secret-for-leads-0123456789';
const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const config = { sampleReportUrl: 'https://example.com/sample', agencyLeadMinSpendBand: null, agencyLeadManagers: ['nobody'] as const };

/** A tiny fake of the three calls sendLeadFollowup makes. */
function fakeSupabase(options: { existingUser?: boolean; claim?: boolean | 'error' } = {}) {
  const updates: any[] = [];
  const supabase = {
    updates,
    from(table: string) {
      if (table === 'users') {
        return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: options.existingUser ? { id: 'u' } : null, error: null }) }) }) }) };
      }
      return { update: (patch: any) => ({ eq: async () => { updates.push(patch); return { error: null }; } }) };
    },
    rpc: async () => (options.claim === 'error' ? { data: null, error: { message: 'boom' } } : { data: options.claim ?? true, error: null }),
  };
  return supabase;
}

const lead = { id: LEAD_ID, channel: 'email', email: 'a@b.com' };

test('the popup stays hidden until BOTH the report link and the text approval exist', () => {
  assert.equal(exitPopupEnabled(), false); // shipped state
  assert.equal(exitPopupEnabled(config, true), true);
  assert.equal(exitPopupEnabled(config, false), false);
  assert.equal(exitPopupEnabled({ ...config, sampleReportUrl: null }, true), false);
  assert.equal(exitPopupEnabled({ ...config, sampleReportUrl: 'http://example.com/x' }, true), false); // https only
  assert.equal(exitPopupEnabled({ ...config, sampleReportUrl: 'not a url' }, true), false);
});

test('shipped state: the follow-up text is NOT approved', () => {
  assert.equal(LEAD_FOLLOWUP.approved, false);
});

test('not approved: nothing is claimed and nothing is sent', async () => {
  let sent = 0;
  const supabase = fakeSupabase();
  const result = await sendLeadFollowup(lead, { supabase, approved: false, config, emailConfigured: () => true, sendEmail: async () => { sent += 1; return { sent: true as const, id: 'x' }; } });
  assert.deepEqual(result, { status: 'not_approved' });
  assert.equal(sent, 0);
  assert.equal(supabase.updates.length, 0);
});

test('approved: sends once with the report link and a signed unsubscribe link', async () => {
  const calls: any[] = [];
  const supabase = fakeSupabase();
  const result = await sendLeadFollowup(lead, {
    supabase, approved: true, config, emailConfigured: () => true,
    sendEmail: async (payload) => { calls.push(payload); return { sent: true as const, id: 'resend-1' }; },
    now: () => new Date('2026-10-14T10:00:00Z'),
  });
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'a@b.com');
  assert.equal(calls[0].idempotencyKey, `lead-followup-${LEAD_ID}`);
  assert.match(calls[0].html, /https:\/\/example\.com\/sample/);
  assert.match(calls[0].headers['List-Unsubscribe'], /\/api\/leads\/opt-out\?l=/);
  assert.equal(supabase.updates.at(-1).followup_status, 'sent');
  assert.equal(supabase.updates.at(-1).followup_provider_id, 'resend-1');
});

test('a lost claim race sends nothing', async () => {
  let sent = 0;
  const result = await sendLeadFollowup(lead, { supabase: fakeSupabase({ claim: false }), approved: true, config, emailConfigured: () => true, sendEmail: async () => { sent += 1; return { sent: true as const, id: 'x' }; } });
  assert.deepEqual(result, { status: 'duplicate' });
  assert.equal(sent, 0);
});

test('someone who already signed up is not pitched', async () => {
  let sent = 0;
  const supabase = fakeSupabase({ existingUser: true });
  const result = await sendLeadFollowup(lead, { supabase, approved: true, config, emailConfigured: () => true, sendEmail: async () => { sent += 1; return { sent: true as const, id: 'x' }; } });
  assert.deepEqual(result, { status: 'skipped', reason: 'already_user' });
  assert.equal(sent, 0);
  assert.equal(supabase.updates[0].followup_status, 'skipped');
});

test('a provider failure is recorded as failed, a thrown error too', async () => {
  const a = fakeSupabase();
  const r1 = await sendLeadFollowup(lead, { supabase: a, approved: true, config, emailConfigured: () => true, sendEmail: async () => ({ sent: false as const, reason: 'email_not_configured' as const }) });
  assert.equal(r1.status, 'failed');
  assert.equal(a.updates.at(-1).followup_status, 'failed');
  const b = fakeSupabase();
  const r2 = await sendLeadFollowup(lead, { supabase: b, approved: true, config, emailConfigured: () => true, sendEmail: async () => { throw new Error('Resend returned 500'); } });
  assert.equal(r2.status, 'failed');
  assert.equal(b.updates.at(-1).followup_reason, 'send_threw');
  assert.doesNotMatch(JSON.stringify(b.updates), /Resend returned 500/, 'the provider text is never stored');
});

test('no email service, a whatsapp lead, or no sample link: nothing is claimed', async () => {
  const supabase = fakeSupabase();
  const noMail = await sendLeadFollowup(lead, { supabase, approved: true, config, emailConfigured: () => false });
  assert.deepEqual(noMail, { status: 'not_configured' });
  const wa = await sendLeadFollowup({ id: LEAD_ID, channel: 'whatsapp', email: null }, { supabase, approved: true, config, emailConfigured: () => true });
  assert.deepEqual(wa, { status: 'skipped', reason: 'not_email' });
  const noLink = await sendLeadFollowup(lead, { supabase, approved: true, config: { ...config, sampleReportUrl: null }, emailConfigured: () => true });
  assert.equal(noLink.status, 'skipped');
  assert.equal(supabase.updates.length, 0);
});

test('the sweep does nothing while the text is unapproved', async () => {
  const supabase = { from: () => { throw new Error('must not query'); } };
  const summary = await sendDueLeadFollowups(supabase, { deps: { approved: false } });
  assert.equal(summary.checked, 0);
  assert.equal(summary.not_approved, 1);
});

test('the sweep sends to each waiting lead once and counts results', async () => {
  const rows = [lead, { id: '22222222-2222-4222-8222-222222222222', channel: 'email', email: 'c@d.com' }];
  const queried: string[] = [];
  const supabase: any = {
    from(table: string) {
      if (table === 'users') return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
      const builder: any = {
        select: () => builder, eq: (c: string) => { queried.push(c); return builder; }, in: () => builder, lt: () => builder, gte: () => builder,
        order: () => builder, limit: async () => ({ data: rows, error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return builder;
    },
    rpc: async () => ({ data: true, error: null }),
  };
  let sent = 0;
  const summary = await sendDueLeadFollowups(supabase, { deps: { approved: true, config, emailConfigured: () => true, sendEmail: async () => { sent += 1; return { sent: true as const, id: 'x' }; } } });
  assert.equal(summary.sent, 2);
  assert.equal(sent, 2);
  assert.ok(queried.includes('messages_opt_out'), 'opted-out leads are never selected');
});

test('the email carries the house copy and nothing it should not', () => {
  const email = renderLeadFollowup({ id: LEAD_ID }, { config })!;
  assert.ok(email);
  assert.match(email.html, /افتح نموذج التقرير/);
  assert.match(email.footer, /أوقفها من هنا/);
  assert.equal(renderLeadFollowup({ id: LEAD_ID }, { config: { ...config, sampleReportUrl: null } }), null);
});

test('lead and user unsubscribe tokens are not interchangeable', () => {
  const leadUrl = new URL(buildLeadOptOutUrl(LEAD_ID)!);
  const userUrl = new URL(buildOptOutUrl(LEAD_ID)!);
  const leadToken = leadUrl.searchParams.get('t');
  const userToken = userUrl.searchParams.get('t');
  assert.notEqual(leadToken, userToken);
  assert.equal(verifyLeadOptOutToken(LEAD_ID, leadToken), true);
  assert.equal(verifyLeadOptOutToken(LEAD_ID, userToken), false);
  assert.equal(verifyOptOutToken(LEAD_ID, leadToken), false);
  assert.equal(verifyOptOutToken(LEAD_ID, userToken), true);
  assert.equal(verifyLeadOptOutToken('22222222-2222-4222-8222-222222222222', leadToken), false);
  assert.equal(verifyLeadOptOutToken('not-a-uuid', leadToken), false);
  assert.equal(verifyLeadOptOutToken(null, leadToken), false);
});
