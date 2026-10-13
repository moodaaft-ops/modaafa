import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractAttribution,
  mergeAttribution,
  parseAttributionCookie,
  pickAttribution,
  sanitizeAttribution,
  serializeAttribution,
} from '../lib/registration/attribution';

const NOW = new Date('2026-10-12T10:00:00Z');

test('a UTM link is captured with its click ids and landing path', () => {
  const a = extractAttribution(
    new URLSearchParams('utm_source=tiktok&utm_medium=paid&utm_campaign=oct&ttclid=E.C.P.abc123XYZ&gclid=Cj0KCQabcdef'),
    '/',
    NOW,
  );
  assert.equal(a.utm_source, 'tiktok');
  assert.equal(a.utm_campaign, 'oct');
  assert.equal(a.ttclid, 'E.C.P.abc123XYZ');
  assert.equal(a.gclid, 'Cj0KCQabcdef');
  assert.equal(a.landing_path, '/');
  assert.ok(a.captured_at);
});

test('a plain visit captures nothing, so it never overwrites a real source', () => {
  assert.deepEqual(extractAttribution(new URLSearchParams(''), '/pricing', NOW), {});
});

test('click ids with odd characters are dropped, long values are cut', () => {
  const a = sanitizeAttribution({ ttclid: '<script>alert(1)</script>', utm_source: 'x'.repeat(500), utm_medium: 'a\u0000b\nc' });
  assert.equal(a.ttclid, undefined);
  assert.equal(a.utm_source?.length, 200);
  assert.equal(a.utm_medium, 'abc');
});

test('cookie round trip keeps the data and survives garbage', () => {
  const a = extractAttribution(new URLSearchParams('utm_source=tiktok&ttclid=abcdef123'), '/x', NOW);
  assert.deepEqual(parseAttributionCookie(serializeAttribution(a)), a);
  assert.deepEqual(parseAttributionCookie('%%%not json'), {});
  assert.deepEqual(parseAttributionCookie(undefined), {});
});

test('a later visit with a new signal wins, an empty one does not erase', () => {
  const first = extractAttribution(new URLSearchParams('utm_source=tiktok'), '/', NOW);
  const second = extractAttribution(new URLSearchParams('utm_source=google&gclid=abcdef123'), '/', NOW);
  assert.equal(mergeAttribution(first, second).utm_source, 'google');
  assert.equal(mergeAttribution(first, {}).utm_source, 'tiktok');
});

test('metadata from the form beats the cookie only when it carries a signal', () => {
  const cookie = { utm_source: 'cookie' };
  assert.equal(pickAttribution({ utm_source: 'meta' }, cookie).utm_source, 'meta');
  assert.equal(pickAttribution({}, cookie).utm_source, 'cookie');
  assert.equal(pickAttribution('junk', cookie).utm_source, 'cookie');
});
