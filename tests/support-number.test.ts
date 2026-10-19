import assert from 'node:assert/strict';
import test from 'node:test';
import { WHATSAPP, whatsappHref } from '../lib/landing/owner-config';
import { BRAND } from '../lib/seo/site';
import { SUPPORT_WHATSAPP_NUMBER, supportBotHandoffUrl, whatsappHelpUrl } from '../lib/support/contact';

// The number lives in lib/support/contact.ts. When Meta releases the new one,
// this test is the list of places that must agree with it.
test('every WhatsApp link and printed number follows the one constant', () => {
  const wa = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`;
  for (const url of [
    whatsappHref('x'),
    WHATSAPP.general,
    WHATSAPP.noAccount,
    WHATSAPP.fullManagement,
    whatsappHelpUrl('no_ads_account'),
    supportBotHandoffUrl({ summary: 'x' }),
  ]) {
    assert.ok(url.startsWith(`${wa}?text=`), url);
  }
  assert.equal(BRAND.whatsappIntl, `+${SUPPORT_WHATSAPP_NUMBER}`);
  assert.equal(BRAND.whatsappLocal, `0${SUPPORT_WHATSAPP_NUMBER.slice(3)}`);
});
