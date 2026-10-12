import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanPage, cleanUtm, normalizeEmail, normalizeWhatsapp } from '../lib/leads/contact';
import { parseLeadRequest } from '../lib/leads/request';
import { insertLead } from '../lib/leads/store';

const sql = readFileSync(resolve('db/migrations/20261014_visitor_leads.sql'), 'utf8');

test('emails are trimmed, lowercased and checked', () => {
  assert.equal(normalizeEmail('  Ali@Example.COM '), 'ali@example.com');
  for (const bad of ['', 'a@b', 'a b@c.com', 'a@b.c', '<x>@y.com', 'a@b.com,c@d.com', 'a@b.com;c@d.com', 12, null, 'x'.repeat(260) + '@a.com']) {
    assert.equal(normalizeEmail(bad as any), null, String(bad));
  }
});

test('Saudi numbers in every common shape become 9665XXXXXXXX', () => {
  for (const input of ['0501234567', '501234567', '966501234567', '+966 50 123 4567', '00966501234567', '٠٥٠١٢٣٤٥٦٧', '050-123-4567']) {
    assert.equal(normalizeWhatsapp(input), '966501234567', input);
  }
});

test('other countries need a country code, and wrong Saudi lengths are refused', () => {
  assert.equal(normalizeWhatsapp('+971501234567'), '971501234567');
  assert.equal(normalizeWhatsapp('96650123'), null);
  assert.equal(normalizeWhatsapp('0212345678'), null);
  assert.equal(normalizeWhatsapp('123'), null);
  assert.equal(normalizeWhatsapp('1'.repeat(16)), null);
  assert.equal(normalizeWhatsapp(undefined as any), null);
});

test('utm keeps four known keys, short and plain', () => {
  assert.deepEqual(cleanUtm({ utm_source: 'tiktok', utm_medium: 'paid<script>', other: 'x', utm_campaign: 'a'.repeat(200) }), {
    utm_source: 'tiktok',
    utm_medium: 'paidscript',
    utm_campaign: 'a'.repeat(80),
  });
  assert.deepEqual(cleanUtm(null), {});
});

test('page keeps a plain path only', () => {
  assert.equal(cleanPage('/?utm_source=x#y'), '/');
  assert.equal(cleanPage('/landing/a-b'), '/landing/a-b');
  assert.equal(cleanPage('javascript:alert(1)'), '/');
  assert.equal(cleanPage('//evil.com'), '/');
  assert.equal(cleanPage(5 as any), '/');
});

test('parseLeadRequest: a valid email and a valid number', () => {
  const email = parseLeadRequest({ channel: 'email', contact: 'A@b.com', source: 'exit_mobile', page: '/', utm: { utm_source: 'tiktok' } }) as any;
  assert.equal(email.ok, true);
  assert.equal(email.lead.email, 'a@b.com');
  assert.equal(email.lead.whatsapp, null);
  assert.equal(email.lead.source, 'exit_mobile');
  const wa = parseLeadRequest({ channel: 'whatsapp', contact: '0501234567' }) as any;
  assert.equal(wa.lead.whatsapp, '966501234567');
  assert.equal(wa.lead.email, null);
  assert.equal(wa.lead.source, 'exit_desktop');
});

test('parseLeadRequest: the contact must match the chosen channel', () => {
  assert.equal((parseLeadRequest({ channel: 'email', contact: '0501234567' }) as any).error, 'invalid_contact');
  assert.equal((parseLeadRequest({ channel: 'whatsapp', contact: 'a@b.com' }) as any).error, 'invalid_contact');
  assert.equal((parseLeadRequest({ channel: 'sms', contact: 'a@b.com' }) as any).error, 'invalid_channel');
  assert.equal((parseLeadRequest(null) as any).error, 'invalid_body');
});

test('parseLeadRequest: the hidden field marks a bot, and nothing is stored for it', () => {
  const bot = parseLeadRequest({ channel: 'email', contact: 'a@b.com', website: 'http://spam' }) as any;
  assert.deepEqual(bot, { ok: true, spam: true });
  const human = parseLeadRequest({ channel: 'email', contact: 'a@b.com', website: '   ' }) as any;
  assert.equal(human.spam, false);
});

test('insertLead: created, duplicate (unique index) and unavailable', async () => {
  const lead = { channel: 'email' as const, email: 'a@b.com', whatsapp: null, source: 'exit_desktop' as const, page: '/', utm: {} };
  const inserted: any[] = [];
  const ok = { from: () => ({ insert: (row: any) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: 'L1' }, error: null }) }) }; } }) };
  assert.deepEqual(await insertLead(lead, { client: ok }), { status: 'created', id: 'L1' });
  assert.equal(inserted[0].email, 'a@b.com');
  const dup = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '23505' } }) }) }) }) };
  assert.deepEqual(await insertLead(lead, { client: dup }), { status: 'duplicate' });
  const down = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '42P01', message: 'no table' } }) }) }) }) };
  assert.deepEqual(await insertLead(lead, { client: down }), { status: 'unavailable' });
  const boom = { from: () => { throw new Error('x'); } };
  assert.deepEqual(await insertLead(lead, { client: boom }), { status: 'unavailable' });
});

test('visitor_leads: one contact per row, stored once, server-only', () => {
  assert.match(sql, /constraint visitor_leads_one_contact check/i);
  assert.match(sql, /create unique index if not exists visitor_leads_email_once on public\.visitor_leads \(email_key\) where email_key is not null/i);
  assert.match(sql, /create unique index if not exists visitor_leads_whatsapp_once on public\.visitor_leads \(whatsapp\) where whatsapp is not null/i);
  assert.match(sql, /alter table public\.visitor_leads enable row level security/i);
  assert.match(sql, /revoke all on table public\.visitor_leads from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant select, insert, update on table public\.visitor_leads to service_role/i);
  assert.match(sql, /revoke all on function public\.claim_lead_followup\(uuid\) from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.claim_lead_followup\(uuid\) to service_role/i);
  assert.doesNotMatch(sql, /create policy/i);
  // Additive only: nothing in the file touches an existing table.
  assert.doesNotMatch(sql, /alter table public\.(users|message_log|user_events)/i);
  assert.doesNotMatch(sql, /drop (table|column)/i);
});

test('one mailbox is one row: +tags and gmail dots collapse, other dots do not', async () => {
  const { emailKey } = await import('../lib/leads/contact');
  assert.equal(emailKey('victim+1@gmail.com'), 'victim@gmail.com');
  assert.equal(emailKey('v.i.c.t.i.m+x@googlemail.com'), 'victim@gmail.com');
  assert.equal(emailKey('first.last+news@company.sa'), 'first.last@company.sa');
  assert.equal(emailKey('a.b@company.sa'), 'a.b@company.sa');
});

test('an IPv6 address is bucketed by its /64, IPv4 is untouched', async () => {
  const { rateLimitBucket } = await import('../lib/leads/contact');
  assert.equal(rateLimitBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(rateLimitBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(rateLimitBucket('2001:db8:1:2:1111::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitBucket(null), null);
});

test('a ten digit number starting with 5 is a typo, not an international number', async () => {
  const { normalizeWhatsapp } = await import('../lib/leads/contact');
  assert.equal(normalizeWhatsapp('5012345678'), null);
  assert.equal(normalizeWhatsapp('0501234567'), '966501234567');
});
