import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContentSecurityPolicy, generateNonce, NONCE_HEADER } from '../lib/security/csp';

function directive(policy: string, name: string) {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? null;
}

test('script-src carries the nonce and never allows unsafe-inline', () => {
  const policy = buildContentSecurityPolicy('AbC123==');
  const scriptSrc = directive(policy, 'script-src');

  assert.ok(scriptSrc, 'script-src must be present');
  assert.ok(scriptSrc.includes("'nonce-AbC123=='"), 'the nonce must be quoted and prefixed');
  // This is the whole point of the change. `'unsafe-inline'` in script-src
  // makes the rest of the policy decorative: anything able to inject a tag can
  // inject its body too.
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline'");
  assert.ok(scriptSrc.includes("'strict-dynamic'"), "'strict-dynamic' is what lets Next's own chunks load");
});

test('the directives that make a nonce meaningful are all present', () => {
  const policy = buildContentSecurityPolicy('n');

  // Without base-uri, an injected <base> retargets every relative script URL
  // and walks straight around script-src.
  assert.equal(directive(policy, 'base-uri'), "base-uri 'self'");
  assert.equal(directive(policy, 'object-src'), "object-src 'none'");
  assert.equal(directive(policy, 'frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(directive(policy, 'default-src'), "default-src 'self'");
  assert.ok(directive(policy, 'form-action')?.includes('https://checkout.stripe.com'));
  assert.ok(directive(policy, 'connect-src')?.includes('https://*.supabase.co'));
  assert.ok(policy.includes('upgrade-insecure-requests'));
});

test('style-src keeps unsafe-inline deliberately', () => {
  // Next and the font loader emit inline <style> blocks that cannot take a
  // nonce. This asserts the decision so a future tightening is a conscious
  // edit to a failing test rather than a silent breakage of every page — and
  // so the exception stays confined to styles, where an injected rule is a far
  // weaker primitive than an injected script.
  const policy = buildContentSecurityPolicy('n');
  assert.ok(directive(policy, 'style-src')?.includes("'unsafe-inline'"));
  assert.ok(!directive(policy, 'script-src')?.includes("'unsafe-inline'"));
  assert.ok(!directive(policy, 'default-src')?.includes("'unsafe-inline'"));
});

test('a nonce is unpredictable and long enough to be worth having', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(generateNonce());
  assert.equal(seen.size, 500, 'every nonce must be distinct');

  const nonce = generateNonce();
  // 16 random bytes → 24 base64 chars. The CSP spec asks for at least 128 bits.
  assert.equal(Buffer.from(nonce, 'base64').length, 16);
  assert.match(nonce, /^[A-Za-z0-9+/]+={0,2}$/, 'must be base64 with no characters that break the header');
});

test('the nonce never contains a character that could terminate the directive', () => {
  for (let i = 0; i < 200; i += 1) {
    const nonce = generateNonce();
    assert.ok(!nonce.includes(';'), 'a semicolon would start a new directive');
    assert.ok(!nonce.includes("'"), 'a quote would close the source expression');
    assert.ok(!/\s/.test(nonce), 'whitespace would split the source list');
  }
});

test('the header name matches what the root layout reads', () => {
  assert.equal(NONCE_HEADER, 'x-nonce');
});
