import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { isLeadLoopEnabled, isLeadLoopServing } from '@/lib/lead-loop/flag';
import { REF_ALPHABET, extractRefCode, generateRefCode, generateSlug, isValidRefCode, isValidSlug } from '@/lib/lead-loop/ref-code';
import { parseLeadClickParams, hasClickId } from '@/lib/lead-loop/click-ids';
import { buildPlainWhatsappUrl, buildWhatsappUrl, cleanWhatsappText, normalizeWhatsappNumber, composeWhatsappMessage } from '@/lib/lead-loop/whatsapp';
import { planLeadRedirect } from '@/lib/lead-loop/redirect';
import { buildMarkPatch, parseMarkInput, parseValueSar } from '@/lib/lead-loop/marking';
import { createLeadRedirectHandler, looksAutomated } from '@/lib/lead-loop/redirect-handler';

test('flag defaults off and honours the three modes', () => {
  assert.equal(isLeadLoopEnabled({}, 'a@b.com'), false);
  assert.equal(isLeadLoopEnabled({ LEAD_LOOP_ENABLED: 'false' }, 'a@b.com'), false);
  assert.equal(isLeadLoopEnabled({ LEAD_LOOP_ENABLED: 'true' }, null), true);
  assert.equal(isLeadLoopEnabled({ LEAD_LOOP_ENABLED: 'operators' }, 'x@y.com'), false);
  assert.equal(isLeadLoopEnabled({ LEAD_LOOP_ENABLED: 'operators', LEAD_LOOP_ALLOWLIST: 'x@y.com' }, 'X@y.com'), true);
  assert.equal(isLeadLoopServing({}), false);
  assert.equal(isLeadLoopServing({ LEAD_LOOP_ENABLED: 'true' }), true);
});

test('ref code generation uses the unambiguous alphabet and is collision-resistant in shape', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateRefCode();
    assert.match(code, /^M-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    assert.ok(isValidRefCode(code));
  }
  assert.ok(!REF_ALPHABET.includes('O') && !REF_ALPHABET.includes('0') && !REF_ALPHABET.includes('I') && !REF_ALPHABET.includes('1'));
  assert.equal(generateRefCode(5).length, 7);
  const fixed = generateRefCode(4, (n) => new Uint8Array(n).fill(0));
  assert.equal(fixed, 'M-2222');
  assert.ok(isValidSlug(generateSlug()));
  assert.ok(!isValidSlug('x'));
});

test('ref code is found in a pasted whatsapp message and not in ordinary words', () => {
  assert.equal(extractRefCode('السلام عليكم، ابي استفسر (M-7K2Q)'), 'M-7K2Q');
  assert.equal(extractRefCode('m-7k2q'), 'M-7K2Q');
  assert.equal(extractRefCode('M 7k2q'), 'M-7K2Q');
  assert.equal(extractRefCode('7k2q'), null);
  assert.equal(extractRefCode('MASTER plan'), null);
  assert.equal(extractRefCode(''), null);
  assert.equal(extractRefCode(null), null);
});

test('click params: ids and utm are captured, junk is dropped', () => {
  const params = parseLeadClickParams(
    new URLSearchParams('gclid=Cj0KCQ_abc-123&utm_source=google&utm_campaign=sale&utm_term=x%20y&lp=/offers&gbraid=<script>'),
    'https://example.com/offers?x=1'
  );
  assert.equal(params.gclid, 'Cj0KCQ_abc-123');
  assert.equal(params.utm_source, 'google');
  assert.equal(params.gbraid, undefined);
  assert.ok(hasClickId(params));
  assert.ok(!hasClickId(parseLeadClickParams(new URLSearchParams(''), null)));
});

test('whatsapp number validation and url building', () => {
  for (const ok of ['0551234567', '+966551234567', '966 55 123 4567', '٠٥٥١٢٣٤٥٦٧']) {
    const r = normalizeWhatsappNumber(ok);
    assert.ok(r.ok, ok);
    if (r.ok) assert.equal(r.number, '966551234567');
  }
  for (const bad of ['', 'abc', '123', '0112345678', '05512345']) assert.equal(normalizeWhatsappNumber(bad).ok, false, bad);
  const url = buildWhatsappUrl('966551234567', 'مرحبا', 'M-7K2Q');
  assert.ok(url.startsWith('https://wa.me/966551234567?text='));
  assert.ok(decodeURIComponent(url).includes('M-7K2Q'));
  assert.ok(!buildPlainWhatsappUrl('966551234567', 'مرحبا').includes('M-'));
  assert.ok(composeWhatsappMessage(null, 'M-7K2Q').includes('M-7K2Q'));
  assert.ok(cleanWhatsappText('x'.repeat(1000)).length <= 300);
});

test('redirect plan stores the click id and sends to the merchant number with the ref', () => {
  const plan = planLeadRedirect({
    settings: { account_id: 'acc', whatsapp_number: '966551234567', default_text: 'هلا' },
    searchParams: new URLSearchParams('gclid=G1G1G1G1G1G1&utm_campaign=c1'),
    now: new Date('2026-10-19T10:00:00Z'),
    random: (n) => new Uint8Array(n).fill(1),
  });
  assert.equal(plan.click.gclid, 'G1G1G1G1G1G1');
  assert.equal(plan.click.has_click_id, true);
  assert.equal(plan.click.account_id, 'acc');
  assert.ok(decodeURIComponent(plan.url).includes(plan.click.ref_code));
  const widened = planLeadRedirect({
    settings: { account_id: 'acc', whatsapp_number: '966551234567', default_text: null },
    searchParams: new URLSearchParams(''),
    now: new Date(),
    attempt: 4,
  });
  assert.equal(widened.click.ref_code.length, 8);
  assert.equal(widened.click.has_click_id, false);
});

test('marking parses values, locks uploaded rows and decides the upload state', () => {
  assert.equal(parseValueSar('١٬٥٠٠'), 1500);
  assert.equal(parseValueSar('1,500.5'), 1500.5);
  assert.equal(parseValueSar(''), null);
  assert.equal(parseValueSar('-3'), 'invalid');
  assert.equal(parseValueSar('abc'), 'invalid');
  assert.deepEqual(parseMarkInput({ status: 'customer', value_sar: '200' }), { ok: true, input: { status: 'customer', value_sar: 200 } });
  assert.deepEqual(parseMarkInput({ status: 'no_reply', value_sar: '200' }), { ok: true, input: { status: 'no_reply', value_sar: null } });
  assert.equal(parseMarkInput({ status: 'new' }).ok, false);
  assert.equal(parseMarkInput({ status: 'customer', value_sar: 'x' }).ok, false);

  const now = new Date('2026-10-19T10:00:00Z');
  const withClick = buildMarkPatch({ status: 'new', upload_status: 'none', gclid: 'G' }, { status: 'customer', value_sar: 100 }, now);
  assert.ok(withClick.ok && withClick.patch.upload_status === 'pending');
  const noClick = buildMarkPatch({ status: 'new', upload_status: 'none' }, { status: 'customer', value_sar: null }, now);
  assert.ok(noClick.ok && noClick.patch.upload_status === 'skipped');
  const notCustomer = buildMarkPatch({ status: 'new', upload_status: 'none', gclid: 'G' }, { status: 'not_serious', value_sar: null }, now);
  assert.ok(notCustomer.ok && notCustomer.patch.upload_status === 'none');
  const locked = buildMarkPatch({ status: 'customer', upload_status: 'uploaded', gclid: 'G' }, { status: 'no_reply', value_sar: null }, now);
  assert.deepEqual(locked, { ok: false, error: 'locked_uploaded' });
});

function req(path: string, ua = 'Mozilla/5.0 (iPhone) Safari', method = 'GET') {
  return new NextRequest(`https://ai.modaafa.com${path}`, { method, headers: { 'user-agent': ua } });
}

const allowed = async () => ({ allowed: true, remaining: 1, limit: 1, resetAt: 0 }) as any;
const settingsRow = { account_id: 'acc', slug: 'abcdefghij', whatsapp_number: '966551234567', default_text: 'هلا', enabled: true } as any;

test('redirect handler: unknown slug and flag off are 404, real visit records and redirects', async () => {
  const recorded: unknown[] = [];
  const base = {
    createAdminClient: () => ({}) as any,
    checkRateLimit: allowed,
    resolveClientIp: () => '1.1.1.1',
    isLeadLoopServing: () => true,
    getSettingsBySlug: async (_db: unknown, slug: string) => (slug === 'abcdefghij' ? settingsRow : null),
    recordLeadClick: async (_db: unknown, _s: unknown, input: unknown) => {
      recorded.push(input);
      return { url: 'https://wa.me/966551234567?text=x%20M-7K2Q', ref: 'M-7K2Q' } as any;
    },
    now: () => new Date('2026-10-19T10:00:00Z'),
  };
  const off = createLeadRedirectHandler({ ...base, isLeadLoopServing: () => false });
  assert.equal((await off(req('/w/abcdefghij'), 'abcdefghij')).status, 404);

  const handler = createLeadRedirectHandler(base);
  assert.equal((await handler(req('/w/zzzzzzzzzz'), 'zzzzzzzzzz')).status, 404);

  const ok = await handler(req('/w/abcdefghij?gclid=G1G1G1G1G1G1'), 'abcdefghij');
  assert.equal(ok.status, 302);
  assert.ok(ok.headers.get('location')!.startsWith('https://wa.me/966551234567'));
  assert.equal(recorded.length, 1);
  assert.equal(ok.headers.get('cache-control'), 'no-store, max-age=0');
});

test('redirect handler: bots, HEAD, rate limit and storage failure still redirect without recording', async () => {
  let recordCalls = 0;
  const base = {
    createAdminClient: () => ({}) as any,
    checkRateLimit: allowed,
    resolveClientIp: () => '1.1.1.1',
    isLeadLoopServing: () => true,
    getSettingsBySlug: async () => settingsRow,
    recordLeadClick: async () => {
      recordCalls += 1;
      return { url: 'https://wa.me/x', ref: 'M-AAAA' } as any;
    },
    now: () => new Date(),
  };
  const bot = await createLeadRedirectHandler(base)(req('/w/abcdefghij', 'Googlebot/2.1'), 'abcdefghij');
  assert.equal(bot.status, 302);
  const head = await createLeadRedirectHandler(base)(req('/w/abcdefghij', undefined, 'HEAD'), 'abcdefghij');
  assert.equal(head.status, 302);
  const limited = await createLeadRedirectHandler({ ...base, checkRateLimit: async () => ({ allowed: false }) as any })(req('/w/abcdefghij'), 'abcdefghij');
  assert.equal(limited.status, 302);
  const limiterDown = await createLeadRedirectHandler({ ...base, checkRateLimit: async () => { throw new Error('down'); } })(req('/w/abcdefghij'), 'abcdefghij');
  assert.equal(limiterDown.status, 302);
  const storageDown = await createLeadRedirectHandler({ ...base, recordLeadClick: async () => { throw new Error('db'); } })(req('/w/abcdefghij'), 'abcdefghij');
  assert.equal(storageDown.status, 302);
  assert.ok(!storageDown.headers.get('location')!.includes('M-'));
  assert.equal(recordCalls, 0 + 0 + 0 + 0);
  assert.ok(looksAutomated(null) && looksAutomated('WhatsApp/2.23') && !looksAutomated('Mozilla/5.0 (Linux; Android 14) Chrome/120'));
});
