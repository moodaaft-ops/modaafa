import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_SITE_AUDIENCES, noSiteOffer, noSiteWhatsappUrl, resolveNoSiteAudience } from '../lib/setup/no-site';
import { SUPPORT_WHATSAPP_NUMBER } from '../lib/support/contact';
import { answerEffects, answerLabel, parseAnswer, reactionTo, type SetupAnswer } from '../lib/setup/questions';

function build(): SetupAnswer {
  const parsed = parseAnswer('website', { choice: 'build' });
  assert.equal(parsed.ok, true);
  return (parsed as { ok: true; answer: SetupAnswer }).answer;
}

test('the customer’s own type answer decides the wording', () => {
  assert.equal(resolveNoSiteAudience({ typeChoice: 'ecommerce' }), 'store');
  assert.equal(resolveNoSiteAudience({ typeChoice: 'clinic', kind: 'services' }), 'clinic');
  assert.equal(resolveNoSiteAudience({ typeChoice: 'restaurant' }), 'restaurant');
  assert.equal(resolveNoSiteAudience({ typeChoice: 'real_estate' }), 'real_estate');
  assert.equal(resolveNoSiteAudience({ typeChoice: 'local_store' }), 'local');
  assert.equal(resolveNoSiteAudience({ typeChoice: 'education' }), 'education');
});

test('without a type answer the trusted kind wins, and the sector words split «local»', () => {
  assert.equal(resolveNoSiteAudience({ kind: 'clinic' }), 'clinic');
  assert.equal(resolveNoSiteAudience({ kind: 'ecommerce', sector: 'عيادة' }), 'store');
  assert.equal(resolveNoSiteAudience({ kind: 'local', sector: 'مطعم مشويات' }), 'restaurant');
  assert.equal(resolveNoSiteAudience({ kind: 'local', sector: 'محل عطور' }), 'local');
});

test('a free-text sector is matched by its words, anything unknown is general', () => {
  assert.equal(resolveNoSiteAudience({ sector: 'مجمع أسنان' }), 'clinic');
  assert.equal(resolveNoSiteAudience({ sector: 'نقل عفش' }), 'services');
  assert.equal(resolveNoSiteAudience({ sector: 'معهد تدريب' }), 'education');
  assert.equal(resolveNoSiteAudience({ sector: 'غير كذا' }), 'general');
  assert.equal(resolveNoSiteAudience({}), 'general');
  assert.equal(resolveNoSiteAudience({ typeChoice: 'other', sector: null }), 'general');
});

test('every audience has its own words and none breaks the copy rules', () => {
  const seen = new Set<string>();
  for (const audience of NO_SITE_AUDIENCES) {
    const offer = noSiteOffer(audience);
    const all = [offer.tileLabel, offer.title, offer.body, offer.limit, offer.button, offer.opener, offer.bubble];
    for (const text of all) {
      assert.ok(text.trim().length > 0, `${audience} has an empty line`);
      assert.ok(!/[—–]/.test(text), `${audience}: long or medium dash in «${text}»`);
      assert.ok(!/[؀-ۿ],\s?[؀-ۿ]/.test(text), `${audience}: Latin comma inside Arabic in «${text}»`);
      assert.ok(!text.includes('قبل الضريبة'), `${audience}: mentions tax`);
      assert.ok(!/إنستغرام|انستغرام|تيك ?توك|سناب/.test(text), `${audience}: names another ad platform`);
      assert.ok(!/\d+\s?(%|٪|ريال)/.test(text), `${audience}: carries a number nobody gave us`);
      assert.ok(!/(مضمون|نضمن|ضعف المبيعات|ضعف الطلبات|ضعف العملاء|ارتفاع المبيعات)/.test(text), `${audience}: promises a result`);
    }
    assert.ok(offer.limit.length > 10, `${audience} must state its honest limit`);
    assert.ok(!seen.has(offer.body), `${audience} repeats another audience’s text`);
    seen.add(offer.body);
  }
  assert.equal(seen.size, NO_SITE_AUDIENCES.length);
});

test('the WhatsApp link goes to the support number with the audience’s opener and the email', () => {
  const url = new URL(noSiteWhatsappUrl('clinic', ' owner@clinic.sa '));
  assert.equal(url.origin + url.pathname, `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`);
  const text = url.searchParams.get('text') ?? '';
  assert.ok(text.startsWith('السلام عليكم\n'));
  assert.ok(text.includes('عيادتي ما عندها موقع'));
  assert.ok(text.endsWith('ايميلي في المنصة: owner@clinic.sa'));
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
});

test('the link works without an email and never carries line breaks from one', () => {
  const none = new URL(noSiteWhatsappUrl('general')).searchParams.get('text') ?? '';
  assert.ok(!none.includes('ايميلي'));
  const messy = new URL(noSiteWhatsappUrl('store', 'a@b.sa\nمرحبا')).searchParams.get('text') ?? '';
  assert.equal(messy.split('\n').length, 3);
});

test('tapping the button is recorded as a normal website answer, no migration needed', () => {
  const answer = build();
  assert.deepEqual(answer, { key: 'website', choice: 'build' });
  const effects = answerEffects(answer);
  assert.deepEqual(effects.business, {});
  assert.equal(effects.fact?.kind, 'other');
  assert.ok(effects.fact?.fact_ar.includes('ضغط زر الواتساب'));
  assert.equal(effects.fact?.data.choice, 'build');
  assert.equal(answerLabel(answer), 'ما عندي موقع، ابي مضاعف يسوي لي');
  assert.ok(reactionTo(answer));
  assert.equal(reactionTo({ key: 'website', choice: 'later' }), null);
  assert.equal(reactionTo({ key: 'website', choice: 'none' }), null);
});

test('an unknown website choice is still refused', () => {
  assert.deepEqual(parseAnswer('website', { choice: 'whatever' }), { ok: false, error: 'invalid_website' });
});
