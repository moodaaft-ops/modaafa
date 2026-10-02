import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORT_WHATSAPP_NUMBER, whatsappHelpUrl } from '../lib/support/contact';

test('WhatsApp help link targets the support number with a prefilled Arabic message', () => {
  const url = new URL(whatsappHelpUrl('no_ads_account', ' owner@shop.sa '));
  assert.equal(url.origin + url.pathname, `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`);
  const text = url.searchParams.get('text') ?? '';
  assert.ok(text.startsWith('السلام عليكم\n'));
  assert.ok(text.includes('ما عندي حساب اعلانات قوقل'));
  assert.ok(text.endsWith('ايميلي في المنصة: owner@shop.sa'));
});

test('WhatsApp help link works without an email', () => {
  const text = new URL(whatsappHelpUrl('manager_only')).searchParams.get('text') ?? '';
  assert.ok(text.includes('MCC'));
  assert.ok(!text.includes('ايميلي'));
});
