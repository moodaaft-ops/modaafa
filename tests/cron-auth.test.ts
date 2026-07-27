import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { hasValidCronAuthorization } from '../lib/security/cron-auth';

function request(authorization?: string) {
  return new NextRequest('https://ai.modaafa.com/api/cron/test', {
    headers: authorization ? { authorization } : undefined,
  });
}

test('cron authorization fails closed when the secret is absent', () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(hasValidCronAuthorization(request('Bearer undefined')), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('cron authorization only accepts the exact configured bearer token', () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'launch-secret';
  try {
    assert.equal(hasValidCronAuthorization(request()), false);
    assert.equal(hasValidCronAuthorization(request('Bearer launch-secre')), false);
    assert.equal(hasValidCronAuthorization(request('Bearer launch-secret')), true);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
