import test from 'node:test';
import assert from 'node:assert/strict';
import { toWhatsAppId } from '../lib/whatsapp/phone';
import { canSendWhatsApp, isStopMessage } from '../lib/whatsapp/consent';

test('toWhatsAppId turns every common Saudi spelling into the same id', () => {
  const expected = '966554235720';
  for (const input of ['0554235720', '554235720', '+966554235720', '966554235720', '00966554235720', ' +966 55 423 5720 ']) {
    assert.equal(toWhatsAppId(input), expected, input);
  }
});

test('toWhatsAppId reads Arabic-Indic digits', () => {
  assert.equal(toWhatsAppId('٠٥٥٤٢٣٥٧٢٠'), '966554235720');
});

test('toWhatsAppId keeps other countries as typed and refuses junk', () => {
  assert.equal(toWhatsAppId('+971501234567'), '971501234567');
  assert.equal(toWhatsAppId('+1 (415) 555-0132'), '14155550132');
  assert.equal(toWhatsAppId(''), null);
  assert.equal(toWhatsAppId(null), null);
  assert.equal(toWhatsAppId('abc'), null);
  assert.equal(toWhatsAppId('12345'), null);
  assert.equal(toWhatsAppId('+0123456789012'), null);
});

test('canSendWhatsApp needs an explicit opt-in', () => {
  assert.equal(canSendWhatsApp({}), false);
  assert.equal(canSendWhatsApp({ whatsapp_opt_in_at: null }), false);
  assert.equal(canSendWhatsApp({ whatsapp_opt_in_at: '2026-10-13T10:00:00Z' }), true);
});

test('an opt-out holds until a newer opt-in', () => {
  const base = { whatsapp_opt_in_at: '2026-10-13T10:00:00Z' };
  assert.equal(canSendWhatsApp({ ...base, whatsapp_opt_out_at: '2026-10-14T10:00:00Z' }), false);
  assert.equal(
    canSendWhatsApp({ whatsapp_opt_in_at: '2026-10-15T10:00:00Z', whatsapp_opt_out_at: '2026-10-14T10:00:00Z' }),
    true,
  );
  assert.equal(canSendWhatsApp({ whatsapp_opt_in_at: 'not a date' }), false);
});

test('isStopMessage matches stop words only when they are the whole message', () => {
  for (const text of ['STOP', ' stop. ', 'إيقاف', 'ايقاف', 'الغاء', 'إلغاء الاشتراك', 'Unsubscribe']) {
    assert.equal(isStopMessage(text), true, text);
  }
  for (const text of ['ما ابي اوقف الاشتراك', 'stop the ads please', 'مرحبا', '', null, undefined]) {
    assert.equal(isStopMessage(text as string | null | undefined), false, String(text));
  }
});
