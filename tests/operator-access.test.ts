import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getSubscriptionAccess } from '../lib/billing/entitlements';
import {
  isModaafaOperator,
  parseModaafaOperatorEmails,
} from '../lib/platform/operators';

test('operator emails are normalized and matched exactly', () => {
  const allowlist = ' owner@example.com,OPS@example.com ,, ';

  assert.deepEqual(parseModaafaOperatorEmails(allowlist), [
    'owner@example.com',
    'ops@example.com',
  ]);
  assert.equal(isModaafaOperator(' OWNER@example.com ', allowlist), true);
  assert.equal(isModaafaOperator('owner+other@example.com', allowlist), false);
  assert.equal(isModaafaOperator(null, allowlist), false);
});

test('an authenticated operator receives bounded internal Pro access without a subscription row', async () => {
  const previous = process.env.MODAAFA_OPERATOR_EMAILS;
  process.env.MODAAFA_OPERATOR_EMAILS = 'owner@example.com';
  const supabase = {
    from() {
      throw new Error('operator access must not query Stripe subscription rows');
    },
  };

  try {
    const access = await getSubscriptionAccess(
      supabase,
      'user-1',
      'OWNER@example.com'
    );

    assert.deepEqual(access, {
      active: true,
      plan: 'pro',
      status: 'internal',
      trialEndsAt: null,
      currentPeriodEnd: null,
    });
  } finally {
    if (previous === undefined) delete process.env.MODAAFA_OPERATOR_EMAILS;
    else process.env.MODAAFA_OPERATOR_EMAILS = previous;
  }
});

test('an operator email cannot grant access without an authenticated user id', async () => {
  const previous = process.env.MODAAFA_OPERATOR_EMAILS;
  process.env.MODAAFA_OPERATOR_EMAILS = 'owner@example.com';

  try {
    const access = await getSubscriptionAccess({}, null, 'owner@example.com');
    assert.equal(access.active, false);
    assert.equal(access.plan, null);
  } finally {
    if (previous === undefined) delete process.env.MODAAFA_OPERATOR_EMAILS;
    else process.env.MODAAFA_OPERATOR_EMAILS = previous;
  }
});

test('billing endpoints refuse to create Stripe sessions for operators', () => {
  for (const path of [
    'app/api/billing/checkout/route.ts',
    'app/api/billing/start-trial/route.ts',
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /isModaafaOperator\(user\.email\)/);
    assert.match(source, /internal_access/);
  }
});
