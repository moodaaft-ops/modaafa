import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhone } from '../lib/registration/phone';
import { validateRegistration, normalizeEmail } from '../lib/registration/validate';

const SAUDI = '+966501234567';

test('Saudi numbers in every common form reach the same E.164 value', () => {
  for (const raw of ['0501234567', '501234567', '966501234567', '+966501234567', '00966501234567', '050 123 4567', '050-123-4567', '+966 (50) 123 4567', '٠٥٠١٢٣٤٥٦٧']) {
    const out = normalizePhone(raw);
    assert.deepEqual(out, { ok: true, e164: SAUDI }, raw);
  }
});

test('Persian digits are converted too', () => {
  assert.deepEqual(normalizePhone('۰۵۰۱۲۳۴۵۶۷'), { ok: true, e164: SAUDI });
});

test('foreign numbers need an explicit country code', () => {
  assert.deepEqual(normalizePhone('+971501234567'), { ok: true, e164: '+971501234567' });
  assert.deepEqual(normalizePhone('00971501234567'), { ok: true, e164: '+971501234567' });
  const bare = normalizePhone('0612345678');
  assert.equal(bare.ok, false);
});

test('garbage and short input is rejected', () => {
  for (const raw of ['', '   ', 'abc', '123', '+966123', '+9665012345', '05012345678901', null, undefined, 42]) {
    assert.equal(normalizePhone(raw as never).ok, false, String(raw));
  }
});

test('emails are compared lowercase and trimmed', () => {
  assert.equal(normalizeEmail('  Ayman@Example.COM '), 'ayman@example.com');
});

test('validateRegistration returns clean values', () => {
  const out = validateRegistration({ name: '  أيمن   أمين ', email: ' A@B.co ', phone: '0501234567' });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.email, 'a@b.co');
    assert.equal(out.value.phoneE164, SAUDI);
    assert.ok(out.value.name.length >= 2);
  }
});

test('validateRegistration reports each bad field in Arabic', () => {
  const out = validateRegistration({ name: 'ا', email: 'not-an-email', phone: '12' });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.ok(out.errors.name && out.errors.email && out.errors.phone);
    assert.match(out.errors.phone!, /[؀-ۿ]/);
  }
});

test('email is optional on the complete-details form, where the session supplies it', () => {
  const out = validateRegistration({ name: 'أيمن', phone: '0501234567' }, { requireEmail: false });
  assert.equal(out.ok, true);
});

test('non-string input does not throw', () => {
  const out = validateRegistration({ name: { a: 1 }, email: [], phone: {} } as never);
  assert.equal(out.ok, false);
});
