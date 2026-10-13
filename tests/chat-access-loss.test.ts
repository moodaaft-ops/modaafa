import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ACCESS_LOSS_BILLING_HREF, ACCESS_LOSS_COPY, chatAccessLoss } from '../lib/chat-first/access-loss';
import { ACCOUNT_SUSPENDED_MESSAGE } from '../lib/billing/entitlements';
import { accessRefusal } from '../lib/billing/access-gate';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

test('a 402 subscription_required says the plan stopped and points to the subscription page', () => {
  const lost = chatAccessLoss(402, { error: 'subscription_required' });
  assert.ok(lost);
  assert.equal(lost.code, 'subscription_required');
  assert.equal(lost.message, 'انتهت تجربتك. فعّل اشتراكك عشان تكمل المحادثة.');
  assert.deepEqual(lost.cta, { label: 'فعّل اشتراكك', href: '/billing' });
  assert.equal(ACCESS_LOSS_BILLING_HREF, '/billing');
});

test('a 403 account_suspended shows the suspension message and offers no button', () => {
  const sent = 'حسابك موقوف مؤقتاً. كلمنا.';
  assert.deepEqual(chatAccessLoss(403, { error: 'account_suspended', message: sent }), {
    code: 'account_suspended',
    message: sent,
    cta: null,
  });
  // The route always sends its message; if a body ever lacks it, the same words are the fallback.
  assert.equal(chatAccessLoss(403, { error: 'account_suspended' })?.message, ACCESS_LOSS_COPY.suspended);
  assert.equal(chatAccessLoss(403, { error: 'account_suspended', message: '  ' })?.message, ACCESS_LOSS_COPY.suspended);
  assert.equal(ACCESS_LOSS_COPY.suspended, ACCOUNT_SUSPENDED_MESSAGE);
});

test('it speaks only for the two refusals the access gate sends, by code and by status', () => {
  // The exact bodies the route sends today.
  const never = { active: false, plan: null, suspended: false };
  const refusal = accessRefusal(never);
  assert.ok(refusal);
  assert.equal(chatAccessLoss(refusal.status, refusal.body)?.code, 'subscription_required');
  const suspended = accessRefusal({ active: true, plan: 'growth', suspended: true });
  assert.ok(suspended);
  assert.equal(chatAccessLoss(suspended.status, suspended.body)?.code, 'account_suspended');

  // Other 403s and 402s, and the usual server faults, are not about access.
  for (const [status, body] of [
    [403, { error: 'invalid_origin' }],
    [403, { error: 'ticket_invalid' }],
    [402, { error: 'free_audits_exhausted' }],
    [402, {}],
    [401, { error: 'unauthorized' }],
    [404, { error: 'session_not_found' }],
    [429, { error: 'too_many_requests' }],
    [500, { error: 'subscription_required' }],
    [200, { error: 'account_suspended' }],
    [402, null],
    [403, 'account_suspended'],
  ] as Array<[number, unknown]>) {
    assert.equal(chatAccessLoss(status, body), null, `${status} ${JSON.stringify(body)}`);
  }
});

test('the thread uses it before the generic fault, never offers a retry for it, and refreshes the page', () => {
  const view = read('app/(dashboard)/start/start-client.tsx');
  const lostAt = view.indexOf('chatAccessLoss(res.status, data)');
  const genericAt = view.indexOf("'صار خلل عندنا. جرب مرة ثانية.'");
  assert.ok(lostAt > 0 && genericAt > lostAt, 'the access branch comes first');
  const branch = view.slice(lostAt, genericAt);
  assert.match(branch, /router\.refresh\(\)/);
  assert.match(branch, /action: \{ type: 'subscribe', href: lost\.cta\.href \}/);
  assert.doesNotMatch(branch, /setFailed/);
  assert.match(view, /useRouter\(\)/);
  // A spoken turn ends the call instead of listening again into the same refusal.
  assert.match(branch, /voiceTicket \? \{ reply: '', hasDraft: false, fatal: 'session_ended' \} : null/);
});

test('the helper has no long dash and imports nothing from the server', () => {
  const src = read('lib/chat-first/access-loss.ts');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /[—–]/);
  assert.doesNotMatch(src, /^import /m);
});
