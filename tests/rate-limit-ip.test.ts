import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp } from '../lib/security/rate-limit';

function reqWith(headers: Record<string, string>) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null } };
}

test('a caller-supplied x-forwarded-for prefix cannot choose the rate-limit identity', () => {
  // Vercel-style: the platform appends the real client IP after any inbound
  // chain the attacker sent. The attacker controls the LEFT side only.
  const ip = resolveClientIp(reqWith({ 'x-forwarded-for': 'spoofed-1, spoofed-2, 203.0.113.7' }));
  assert.equal(ip, '203.0.113.7');
});

test('platform-set headers win over the forwarded chain', () => {
  const ip = resolveClientIp(
    reqWith({
      'x-forwarded-for': 'spoofed, 198.51.100.9',
      'x-real-ip': '203.0.113.7',
      'x-vercel-forwarded-for': '203.0.113.8',
    })
  );
  assert.equal(ip, '203.0.113.8');
});

test('x-real-ip is used when x-vercel-forwarded-for is absent', () => {
  const ip = resolveClientIp(reqWith({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': 'spoofed' }));
  assert.equal(ip, '203.0.113.7');
});

test('a single-entry forwarded header still resolves', () => {
  assert.equal(resolveClientIp(reqWith({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
});

test('no headers resolves to null (limiter falls back to the shared unknown bucket)', () => {
  assert.equal(resolveClientIp(reqWith({})), null);
  assert.equal(resolveClientIp(reqWith({ 'x-forwarded-for': ' , ' })), null);
});
