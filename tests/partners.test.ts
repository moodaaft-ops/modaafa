import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { normalizePartnerCode, partnerLink, partnersEnabled, refereeGiftPromoCode } from '../lib/partners/config';
import { commissionBaseMinor } from '../lib/partners/invoice-base';
import { partnerHashSalt, visitorHash } from '../lib/partners/visitor';
import { attachReferralFromRequest } from '../lib/partners/attach';
import { runPartnerAction } from '../lib/partners/ops-actions';
import { formatMoneyMap } from '../lib/partners/format';
import { createStripeWebhookHandler, type StripeWebhookDependencies } from '../lib/billing/stripe-webhook-handler';
import { buildReopenUrl } from '../lib/registration/in-app-browser';

test('codes: trimmed and lower-cased, bad shapes refused', () => {
  assert.equal(normalizePartnerCode('  Sara '), 'sara');
  assert.equal(normalizePartnerCode('a-b_c9'), 'a-b_c9');
  for (const bad of ['ab', '', '-sara', 'sa ra', 'سارة', 'x'.repeat(33), null, undefined, 42, 'a/../b']) {
    assert.equal(normalizePartnerCode(bad), null, String(bad));
  }
  assert.equal(partnerLink('https://ai.modaafa.com/', 'sara'), 'https://ai.modaafa.com/r/sara');
});

test('the programme is off unless PARTNERS_ENABLED is exactly "true"', () => {
  assert.equal(partnersEnabled({}), false);
  assert.equal(partnersEnabled({ PARTNERS_ENABLED: '1' }), false);
  assert.equal(partnersEnabled({ PARTNERS_ENABLED: 'TRUE' }), false);
  assert.equal(partnersEnabled({ PARTNERS_ENABLED: 'true' }), true);
  assert.equal(refereeGiftPromoCode({ PARTNER_REFEREE_PROMO_CODE: '  WELCOME20 ' }), 'WELCOME20');
  assert.equal(refereeGiftPromoCode({ PARTNER_REFEREE_PROMO_CODE: '  ' }), null);
});

test('commission base: what was paid minus tax, zero for a trial invoice', () => {
  assert.equal(commissionBaseMinor({ amount_paid: 0 }), 0);
  assert.equal(commissionBaseMinor({ amount_paid: 11_500, tax: 1_500 }), 10_000);
  assert.equal(commissionBaseMinor({ amount_paid: 11_500, total_taxes: [{ amount: 1_000 }, { amount: 500 }] }), 10_000);
  assert.equal(commissionBaseMinor({ amount_paid: 10_000 }), 10_000);
  assert.equal(commissionBaseMinor({ amount_paid: 500, tax: 900 }), 0, 'never negative');
  assert.equal(commissionBaseMinor({ amount_paid: -5 }), 0);
});

test('visitor hash: stable within a day, different across days, no raw address in it', () => {
  const a = visitorHash('1.2.3.4', 'UA', '2026-10-19', 's');
  assert.equal(a, visitorHash('1.2.3.4', 'UA', '2026-10-19', 's'));
  assert.notEqual(a, visitorHash('1.2.3.4', 'UA', '2026-10-20', 's'));
  assert.notEqual(a, visitorHash('1.2.3.5', 'UA', '2026-10-19', 's'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(partnerHashSalt({ PARTNER_HASH_SALT: 'x', CRON_SECRET: 'y' }), 'x');
});

const reqWithCookie = (cookie?: string) =>
  new NextRequest('https://ai.modaafa.com/auth/callback', { headers: cookie ? { cookie } : {} });

test('attach: off, no cookie, bad cookie, recorded, and a failure never throws', async () => {
  const calls: unknown[][] = [];
  const record = async (...args: unknown[]) => {
    calls.push(args);
    return 'recorded' as const;
  };
  assert.equal(await attachReferralFromRequest(reqWithCookie('mz_ref=sara'), 'u1', { enabled: false, record }), 'off');
  assert.equal(await attachReferralFromRequest(reqWithCookie(), 'u1', { enabled: true, record }), 'no_cookie');
  assert.equal(await attachReferralFromRequest(reqWithCookie('mz_ref=a%20b'), 'u1', { enabled: true, record }), 'no_cookie');
  assert.equal(calls.length, 0);
  assert.equal(await attachReferralFromRequest(reqWithCookie('mz_ref=Sara'), 'u1', { enabled: true, record }), 'recorded');
  assert.deepEqual(calls, [['u1', 'sara', 'link']]);
  const boom = async () => {
    throw new Error('db down');
  };
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await attachReferralFromRequest(reqWithCookie('mz_ref=sara'), 'u1', { enabled: true, record: boom }), 'error');
  } finally {
    console.error = originalError;
  }
});

test('the reopen link for an in-app browser carries the partner code', () => {
  const url = buildReopenUrl('https://ai.modaafa.com', '/register', { utm_source: 'tiktok' }, 'sara');
  assert.equal(url.searchParams.get('ref'), 'sara');
  assert.equal(url.searchParams.get('utm_source'), 'tiktok');
  assert.equal(buildReopenUrl('https://ai.modaafa.com', '/register', {}).searchParams.has('ref'), false);
});

test('ops actions: bad input is refused before the database is touched', async () => {
  const db = new Proxy({}, { get: () => { throw new Error('database must not be touched'); } });
  const run = (input: unknown) => runPartnerAction(db, 'op-1', input);
  const uuid = '11111111-1111-1111-1111-111111111111';
  assert.equal((await run(null)).body.error, 'unknown_action');
  assert.equal((await run({ action: 'create', code: 'x', display_name: 'S', email: 'a@b.co' })).body.error, 'bad_code');
  assert.equal((await run({ action: 'create', code: 'sara', display_name: 'Sara', email: 'nope' })).body.error, 'bad_email');
  assert.equal((await run({ action: 'create', code: 'sara', display_name: 'Sara', email: 'a@b.co', commission_rate: '0.9' })).body.error, 'bad_rate');
  assert.equal((await run({ action: 'status', partner_id: 'x', status: 'active' })).body.error, 'bad_input');
  assert.equal((await run({ action: 'status', partner_id: uuid, status: 'deleted' })).body.error, 'bad_input');
  assert.equal((await run({ action: 'resolve_held', commission_id: uuid, release: 'yes' })).body.error, 'bad_input');
  assert.equal((await run({ action: 'pay_out', partner_id: uuid, currency: 'SAR', method: 'cash', reference: 'R-1' })).body.error, 'bad_input');
  const noRef = await run({ action: 'pay_out', partner_id: uuid, currency: 'SAR', method: 'bank_transfer', reference: ' ', expected: 100 });
  assert.equal((await run({ action: 'pay_out', partner_id: uuid, currency: 'SAR', method: 'bank_transfer', reference: 'R-1' })).body.error, 'expected_required');
  assert.equal(noRef.status, 400);
  assert.equal(noRef.body.error, 'reference_required');
});

test('money formatting: empty is a plain zero, currencies are kept apart', () => {
  assert.match(formatMoneyMap({}), /0/);
  const both = formatMoneyMap({ SAR: 100, USD: 5 });
  assert.match(both, /\+/);
});

// ---- Stripe webhook: the programme must never get in the way of billing ----

const CREATED_AT = Math.floor(new Date('2026-10-19T12:00:00.000Z').getTime() / 1000);

function stripeEvent(type: string, object: object, id: string) {
  return { id, object: 'event', created: CREATED_AT, data: { object }, livemode: false, type } as unknown as Stripe.Event;
}
function request() {
  return new NextRequest('http://localhost/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 's' }, body: '{}' });
}
function handlerFor(ev: Stripe.Event, overrides: Partial<StripeWebhookDependencies>) {
  return createStripeWebhookHandler({
    constructWebhookEvent: () => ev,
    createAdminClient: () => ({}) as any,
    claimStripeWebhookEvent: async () => 'claimed',
    completeStripeWebhookEvent: async () => undefined,
    failStripeWebhookEvent: async () => undefined,
    sendOpsAlert: async () => ({ sent: true, id: 'ops' }),
    ...overrides,
  } as Partial<StripeWebhookDependencies>);
}
function withFlag<T>(value: string | undefined, fn: () => Promise<T>) {
  const before = process.env.PARTNERS_ENABLED;
  if (value === undefined) delete process.env.PARTNERS_ENABLED;
  else process.env.PARTNERS_ENABLED = value;
  return fn().finally(() => {
    if (before === undefined) delete process.env.PARTNERS_ENABLED;
    else process.env.PARTNERS_ENABLED = before;
  });
}

function paidInvoiceHandler(extra: Partial<StripeWebhookDependencies>) {
  const invoice = { id: 'in_1', number: 'INV-0001', subscription: 'sub_1', currency: 'sar', amount_paid: 11_500, tax: 1_500, status: 'paid' };
  const db = {
    from: () => ({
      select() { return this; },
      eq() { return this; },
      async maybeSingle() { return { data: { id: 'row-1', user_id: 'user-1' }, error: null }; },
    }),
  };
  return handlerFor(stripeEvent('invoice.payment_succeeded', invoice, 'evt_paid'), {
    createAdminClient: () => db as any,
    retrieveStripeSubscription: async () => ({ id: 'sub_1', status: 'active', metadata: { userId: 'user-1' }, items: { data: [] }, current_period_start: 1, current_period_end: 2 }) as any,
    planFromSubscription: () => ({ plan: 'starter', period: 'monthly', source: 'metadata' }) as any,
    applySubscriptionEvent: async () => 'updated',
    subscriptionEventWasApplied: (() => true) as any,
    recordPaidInvoice: async () => ({ recorded: true, duplicate: false }),
    recordUserEvent: async () => true,
    ...extra,
  });
}

test('webhook: programme off, a paid invoice earns nothing', async () => {
  let accrued = 0;
  await withFlag(undefined, async () => {
    const res = await paidInvoiceHandler({ accrueInvoiceCommission: async () => { accrued++; return { status: 'earned' }; } })(request());
    assert.equal(res.status, 200);
  });
  assert.equal(accrued, 0);
});

test('webhook: programme on, a paid invoice is accrued once for the right user', async () => {
  const seen: any[] = [];
  await withFlag('true', async () => {
    const res = await paidInvoiceHandler({
      accrueInvoiceCommission: async (_db, input) => { seen.push(input); return { status: 'earned' }; },
    })(request());
    assert.equal(res.status, 200);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, 'user-1');
  assert.equal(seen[0].invoice.number, 'INV-0001');
});

test('webhook: an accrual failure does not fail the event (billing comes first)', async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await withFlag('true', async () => {
      const res = await paidInvoiceHandler({ accrueInvoiceCommission: async () => { throw new Error('partners down'); } })(request());
      assert.equal(res.status, 200);
    });
  } finally {
    console.error = originalError;
  }
});

test('webhook: a trial invoice (nothing paid) never reaches the accrual', async () => {
  let accrued = 0;
  const invoice = { id: 'in_0', subscription: 'sub_1', currency: 'sar', amount_paid: 0, status: 'paid' };
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { id: 'r', user_id: 'user-1' }, error: null }; } }) };
  await withFlag('true', async () => {
    const res = await handlerFor(stripeEvent('invoice.payment_succeeded', invoice, 'evt_trial'), {
      createAdminClient: () => db as any,
      retrieveStripeSubscription: async () => ({ id: 'sub_1', status: 'trialing', metadata: { userId: 'user-1' }, items: { data: [] } }) as any,
      planFromSubscription: () => ({ plan: 'starter', period: 'monthly', source: 'metadata' }) as any,
      applySubscriptionEvent: async () => 'updated',
      subscriptionEventWasApplied: (() => true) as any,
      recordPaidInvoice: async () => ({ recorded: true, duplicate: false }),
      recordUserEvent: async () => true,
      accrueInvoiceCommission: async () => { accrued++; return { status: 'earned' }; },
    })(request());
    assert.equal(res.status, 200);
  });
  assert.equal(accrued, 0);
});

test('webhook: a full refund voids the commission, a partial one passes its share', async () => {
  const voids: any[][] = [];
  const base = {
    retrieveStripeInvoice: async () => ({ id: 'in_9', number: 'INV-0009' }) as any,
    voidInvoiceCommission: async (_db: unknown, key: string, reason: string, fraction: number) => { voids.push([key, reason, fraction]); return 'voided'; },
  };
  await withFlag('true', async () => {
    const full = await handlerFor(stripeEvent('charge.refunded', { id: 'ch_1', invoice: 'in_9', amount: 11_500, amount_refunded: 11_500, refunded: true }, 'evt_r1'), base)(request());
    assert.equal(full.status, 200);
    const part = await handlerFor(stripeEvent('charge.refunded', { id: 'ch_2', invoice: 'in_9', amount: 11_500, amount_refunded: 2_000, refunded: false }, 'evt_r2'), base)(request());
    assert.equal(part.status, 200);
  });
  assert.equal(voids.length, 2);
  assert.deepEqual(voids[0], ['INV-0009', 'refund', 1]);
  assert.equal(voids[1][0], 'INV-0009');
  assert.ok(Math.abs((voids[1][2] as number) - 2000 / 11500) < 1e-9, 'a partial refund passes its share of the invoice');
});

test('webhook: a refund with the programme off does nothing', async () => {
  let called = 0;
  await withFlag(undefined, async () => {
    const res = await handlerFor(stripeEvent('charge.refunded', { id: 'ch_1', invoice: 'in_9', refunded: true }, 'evt_r3'), {
      voidInvoiceCommission: async () => { called++; return 'x'; },
    })(request());
    assert.equal(res.status, 200);
  });
  assert.equal(called, 0);
});

test('webhook: a real dispute voids the commission; a bank inquiry does not', async () => {
  const voids: any[][] = [];
  const deps = {
    retrieveStripeCharge: async () => ({ id: 'ch_d', invoice: 'in_d' }) as any,
    retrieveStripeInvoice: async () => ({ id: 'in_d', number: 'INV-D' }) as any,
    voidInvoiceCommission: async (_db: unknown, key: string, reason: string, fraction: number) => { voids.push([key, reason, fraction]); return 'voided'; },
  };
  await withFlag('true', async () => {
    const dispute = await handlerFor(stripeEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_d', status: 'needs_response' }, 'evt_d1'), deps)(request());
    assert.equal(dispute.status, 200);
    const inquiry = await handlerFor(stripeEvent('charge.dispute.created', { id: 'dp_2', charge: 'ch_d', status: 'warning_needs_response' }, 'evt_d2'), deps)(request());
    assert.equal(inquiry.status, 200);
  });
  assert.deepEqual(voids, [['INV-D', 'dispute', 1]]);
});

test('webhook: a refund whose void fails is retried by Stripe (500), not lost', async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await withFlag('true', async () => {
      const res = await handlerFor(stripeEvent('charge.refunded', { id: 'ch_1', invoice: 'in_9', amount: 100, amount_refunded: 100, refunded: true }, 'evt_rf'), {
        retrieveStripeInvoice: async () => ({ id: 'in_9', number: 'INV-0009' }) as any,
        voidInvoiceCommission: async () => { throw new Error('db down'); },
      })(request());
      assert.equal(res.status, 500);
    });
  } finally {
    console.error = originalError;
  }
});

test('webhook: a dispute still alerts and is handled when the void fails, then Stripe retries', async () => {
  const alerts: string[] = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await withFlag('true', async () => {
      const res = await handlerFor(stripeEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_d', status: 'needs_response' }, 'evt_dx'), {
        retrieveStripeCharge: async () => ({ id: 'ch_d', invoice: 'in_d' }) as any,
        retrieveStripeInvoice: async () => ({ id: 'in_d', number: 'INV-D' }) as any,
        voidInvoiceCommission: async () => { throw new Error('db down'); },
        sendOpsAlert: async (payload: any) => { alerts.push(payload.subject); return { sent: true, id: 'x' }; },
      })(request());
      assert.equal(res.status, 500);
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(alerts.includes('نزاع على دفعة بلا اشتراك معروف'), 'the dispute itself was still handled before the retry');
});

// ---- partner lookup, gift, middleware ----

function chain(log: string[], results: { select?: unknown; update?: unknown }) {
  const q: any = {
    select(cols: string) { log.push(`select`); q._last = 'select'; return q; },
    eq(col: string, value: unknown) { log.push(`eq:${col}=${String(value)}`); return q; },
    ilike() { log.push('ilike'); return q; },
    is() { return q; },
    update() { log.push('update'); q._mode = 'update'; return q; },
    async maybeSingle() { return { data: results.select ?? null, error: null }; },
    then(resolve: any) { return resolve(q._mode === 'update' ? (results.update as any) : { data: null, error: null }); },
  };
  return q;
}

test('partner lookup by email is an exact match, never a pattern', async () => {
  const { findPartnerForUser } = await import('../lib/partners/store');
  const log: string[] = [];
  const row = { id: 'p1', user_id: null, code: 'ali', display_name: 'Ali', email: 'ali.saeed@outlook.com', status: 'active' };
  // First lookup by user finds nothing, the second (by email) finds the row.
  let call = 0;
  const db = { from: () => { call++; return chain(log, call === 2 ? { select: row, update: { data: [{ id: 'p1' }], error: null } } : call === 1 ? {} : { update: { data: [{ id: 'p1' }], error: null } }); } };
  const found = await findPartnerForUser(db, { id: 'u1', email: 'ALI_SAEED@outlook.com' });
  assert.ok(!log.includes('ilike'), 'no pattern matching on an email');
  assert.ok(log.includes('eq:email=ali_saeed@outlook.com'));
  assert.equal(found?.user_id, 'u1');
});

test('partner lookup: a link that changed no row is not a link', async () => {
  const { findPartnerForUser } = await import('../lib/partners/store');
  const row = { id: 'p1', user_id: null, code: 'ali', display_name: 'Ali', email: 'a@x.co', status: 'active' };
  let call = 0;
  const db = { from: () => { call++; return chain([], call === 2 ? { select: row, update: { data: [], error: null } } : call === 1 ? {} : { update: { data: [], error: null } }); } };
  assert.equal(await findPartnerForUser(db, { id: 'u1', email: 'a@x.co' }), null);
});

test('referee gift: only for an open referral of an active partner, and never throws', async () => {
  const { refereeGiftPromotion } = await import('../lib/partners/gift');
  const stripe: any = { findPromotionCode: async () => ({ id: 'promo_1', active: true, coupon: { percent_off: 20, valid: true, duration: 'once' } }) };
  const referral = (status: string, extra: object = {}) => ({ from: () => chain([], { select: { code_used: 'sara', first_paid_at: null, status: 'registered', partners: { status }, ...extra } }) });
  const gift = (db: any, s = stripe) => refereeGiftPromotion({ getDb: () => db, stripe: s }, { userId: 'u1', customerId: 'cus_1' });
  const before = { flag: process.env.PARTNERS_ENABLED, code: process.env.PARTNER_REFEREE_PROMO_CODE };
  try {
    delete process.env.PARTNERS_ENABLED;
    process.env.PARTNER_REFEREE_PROMO_CODE = 'WELCOME20';
    assert.equal(await gift(referral('active')), null, 'programme off');
    process.env.PARTNERS_ENABLED = 'true';
    assert.equal((await gift(referral('active')))?.id, 'promo_1');
    assert.equal(await gift(referral('paused')), null, 'paused partner');
    assert.equal(await gift(referral('banned')), null, 'banned partner');
    assert.equal(await gift(referral('active', { first_paid_at: '2026-10-01' })), null, 'already paid');
    assert.equal(await gift({ from: () => chain([], {}) }), null, 'no referral');
    const originalError = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await gift(referral('active'), { findPromotionCode: async () => { throw new Error('stripe down'); } } as any), null);
      assert.equal(await gift({ from: () => { throw new Error('db down'); } }), null);
    } finally {
      console.error = originalError;
    }
    delete process.env.PARTNER_REFEREE_PROMO_CODE;
    assert.equal(await gift(referral('active')), null, 'no gift code configured');
  } finally {
    for (const [k, v] of [['PARTNERS_ENABLED', before.flag], ['PARTNER_REFEREE_PROMO_CODE', before.code]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('middleware: ?ref sets the cookie only when none is remembered', async () => {
  const { middleware } = await import('../middleware');
  const before = process.env.PARTNERS_ENABLED;
  process.env.PARTNERS_ENABLED = 'true';
  try {
    const fresh = await middleware(new NextRequest('https://ai.modaafa.com/register?ref=Sara'));
    assert.match(fresh.headers.get('set-cookie') ?? '', /mz_ref=sara/);
    const kept = await middleware(new NextRequest('https://ai.modaafa.com/register?ref=zzz', { headers: { cookie: 'mz_ref=omar' } }));
    assert.doesNotMatch(kept.headers.get('set-cookie') ?? '', /mz_ref/);
    process.env.PARTNERS_ENABLED = 'false';
    const off = await middleware(new NextRequest('https://ai.modaafa.com/register?ref=sara'));
    assert.doesNotMatch(off.headers.get('set-cookie') ?? '', /mz_ref/);
  } finally {
    if (before === undefined) delete process.env.PARTNERS_ENABLED;
    else process.env.PARTNERS_ENABLED = before;
  }
});
