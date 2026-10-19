import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Real-Postgres tests for db/migrations/20261019_partner_program.sql.
 * Skipped unless PARTNERS_PG_URL points at an EMPTY scratch database (never
 * production). The suite builds stand-ins for users, subscriptions, invoices and
 * the Supabase roles, takes trial_email_key from the real 20261013 migration,
 * applies the partner migration twice, then drives every money rule.
 */
const url = process.env.PARTNERS_PG_URL;
const skip = url ? false : 'set PARTNERS_PG_URL to run the SQL integration tests';

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const PARTNER_USER = U(1);
const CUSTOMER = U(2);

function psql(sql: string) {
  return execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], { encoding: 'utf8' }).trim();
}
function svc(sql: string) {
  return psql(`set role service_role; ${sql}`).split('\n').pop()!;
}
function fail(sql: string) {
  try {
    svc(sql);
    return '';
  } catch (error: any) {
    return String(error.stderr ?? error.message);
  }
}
function asRole(role: string, sql: string) {
  try {
    return psql(`set role ${role}; ${sql}`).split('\n').pop()!;
  } catch (error: any) {
    return `ERROR: ${String(error.stderr ?? error.message)}`;
  }
}
const accrue = (user: string, key: string, net: number, paidAt = 'now()') =>
  JSON.parse(svc(`select public.partner_accrue_commission('${user}', '${key}', ${net}, 'SAR', (${paidAt})::timestamptz)`));
const newUser = (n: number, email: string, phone = 'null') =>
  psql(`insert into public.users (id, email, phone) values ('${U(n)}', '${email}', ${phone})`);
const newPartner = (code: string, email: string, extra = '') =>
  psql(`insert into public.partners (code, display_name, email ${extra ? ', ' + extra.split('=')[0] : ''}) values ('${code}', 'Partner ${code}', '${email}' ${extra ? ', ' + extra.split('=')[1] : ''})`);

test('setup: stand-ins, real trial_email_key, migration twice', { skip }, () => {
  psql(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    alter role service_role bypassrls;
    create table public.users (id uuid primary key, email text unique not null, phone text);
    create table public.subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id),
      status text, stripe_subscription_id text unique);
    create table public.invoices (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id),
      amount_sar numeric(10,2) not null, currency text not null default 'SAR', status text, invoice_number text,
      paid_at timestamptz, created_at timestamptz default now());
    create table public.trial_card_ledger (fingerprint text primary key, first_user_id uuid not null, stripe_subscription_id text);
    grant usage on schema public to authenticated, service_role, anon;
    grant all on public.users, public.subscriptions, public.invoices, public.trial_card_ledger to service_role;
  `);
  const guards = readFileSync('db/migrations/20261013_trial_abuse_guards.sql', 'utf8');
  const fn = guards.match(/create or replace function public\.trial_email_key[\s\S]*?\n\$\$;/);
  assert.ok(fn, 'trial_email_key not found in the 20261013 migration');
  psql(fn![0]);
  for (let i = 0; i < 2; i++) {
    execFileSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'db/migrations/20261019_partner_program.sql'], { encoding: 'utf8' });
  }
  newUser(1, 'sara.partner@gmail.com');
  newUser(2, 'customer@x.co');
  newPartner('sara', 'sara.partner@gmail.com');
  psql(`update public.partners set user_id='${PARTNER_USER}' where code='sara'`);
});

test('privileges: anon and authenticated see nothing, service_role works', { skip }, () => {
  assert.match(asRole('anon', 'select count(*) from public.partners'), /permission denied/);
  assert.match(asRole('authenticated', 'select count(*) from public.commissions'), /permission denied/);
  assert.match(asRole('authenticated', `select public.partner_pay_out('${U(9)}', 'SAR', 'x', 'x')`), /permission denied/);
  assert.equal(svc('select count(*) from public.partners'), '1');
});

test('clicks: counted once per visitor per day, unknown and inactive codes ignored', { skip }, () => {
  const click = (code: string, v: string) => svc(`select public.partner_record_click('${code}', '${v}', '/pricing')`);
  assert.equal(click('sara', 'a'.repeat(32)), 'recorded');
  assert.equal(click('sara', 'a'.repeat(32)), 'duplicate');
  assert.equal(click('SARA ', 'b'.repeat(32)), 'recorded');
  assert.equal(click('nobody', 'a'.repeat(32)), 'unknown');
  psql(`update public.partners set status='paused' where code='sara'`);
  assert.equal(click('sara', 'c'.repeat(32)), 'unknown');
  psql(`update public.partners set status='active' where code='sara'`);
  assert.equal(svc(`select count(*) from public.referral_clicks`), '2');
});

test('referral: self, unknown, recorded, already, switch by code', { skip }, () => {
  const ref = (u: string, code: string, via = 'link') => svc(`select public.partner_record_referral('${u}', '${code}', '${via}')`);
  newPartner('omar', 'omar@x.co');
  // The partner referring herself, with dots and a plus tag in the address.
  newUser(3, 'sarapartner+test@gmail.com');
  assert.equal(ref(U(3), 'sara'), 'self');
  assert.equal(ref(PARTNER_USER, 'sara'), 'self');
  assert.equal(ref(CUSTOMER, 'ghost'), 'unknown_code');
  assert.equal(ref(CUSTOMER, 'sara'), 'recorded');
  assert.equal(ref(CUSTOMER, 'sara'), 'already');
  assert.equal(ref(CUSTOMER, 'omar'), 'already'); // a link never replaces an earlier one
  assert.equal(ref(CUSTOMER, 'omar', 'code'), 'switched'); // a code typed at checkout does
  assert.equal(svc(`select p.code from public.referrals r join public.partners p on p.id=r.partner_id where r.referred_user_id='${CUSTOMER}'`), 'omar');
  assert.equal(ref(CUSTOMER, 'sara', 'code'), 'switched');
  assert.equal(ref(U(77), 'sara'), 'no_user');
  assert.equal(ref(CUSTOMER, 'sara', 'weird'), 'bad_via');
});

test('accrue: 25%, idempotent, first payment locks the referrer', { skip }, () => {
  const first = accrue(CUSTOMER, 'INV-1', 100);
  assert.equal(first.status, 'earned');
  assert.equal(first.amount, 25);
  assert.equal(first.held, false);
  assert.equal(accrue(CUSTOMER, 'INV-1', 100).status, 'duplicate');
  assert.equal(svc(`select count(*) from public.commissions`), '1');
  assert.equal(svc(`select public.partner_record_referral('${CUSTOMER}', 'omar', 'code')`), 'locked');
  assert.equal(svc(`select status from public.referrals where referred_user_id='${CUSTOMER}'`), 'paying');
  assert.equal(accrue(U(50), 'INV-X', 100).status, 'no_referral');
  assert.equal(accrue(CUSTOMER, 'INV-0', 0).status, 'zero');
});

test('accrue: pending until the hold passes, then payable', { skip }, () => {
  assert.equal(svc(`select status||'|'||(payable_at > now() + interval '29 days')::text from public.commissions where invoice_key='INV-1'`), 'pending|true');
});

test('accrue: 12 month window closes after the first payment', { skip }, () => {
  // first_paid_at is "now"; an invoice 13 months later is outside the window.
  assert.equal(accrue(CUSTOMER, 'INV-LATE', 100, `now() + interval '13 months'`).status, 'expired');
  assert.equal(accrue(CUSTOMER, 'INV-2', 100, `now() + interval '2 months'`).status, 'earned');
});

test('accrue: 30% once more than 10 referred customers are paying', { skip }, () => {
  newPartner('big', 'big@x.co');
  for (let i = 0; i < 11; i++) {
    const n = 100 + i;
    newUser(n, `bulk${i}@x.co`);
    psql(`insert into public.subscriptions (user_id, status) values ('${U(n)}', 'active')`);
    svc(`select public.partner_record_referral('${U(n)}', 'big')`);
  }
  // 11 paying, threshold is "more than 10".
  const r = accrue(U(100), 'BIG-1', 200);
  assert.equal(r.rate, 0.3);
  assert.equal(r.amount, 60);
  // Back to 10 paying: base rate.
  psql(`update public.subscriptions set status='canceled' where user_id='${U(101)}'`);
  assert.equal(accrue(U(102), 'BIG-2', 200).rate, 0.25);
});

test('accrue: a personal rate overrides the tier', { skip }, () => {
  newPartner('vip', 'vip@x.co', 'commission_rate=0.4');
  newUser(200, 'vipcust@x.co');
  svc(`select public.partner_record_referral('${U(200)}', 'vip')`);
  assert.equal(accrue(U(200), 'VIP-1', 100).amount, 40);
});

test('accrue: same email or phone puts the money on hold, not rejected', { skip }, () => {
  newPartner('twin', 'twin@x.co', `phone='+966500000001'`);
  newUser(300, 'someone@x.co', `'+966500000001'`);
  // A referral recorded before the partner changed number stays possible via ops,
  // so force the row and check the accrual-time check on its own.
  psql(`insert into public.referrals (partner_id, referred_user_id, code_used, via)
        select id, '${U(300)}', 'twin', 'ops' from public.partners where code='twin'`);
  const r = accrue(U(300), 'TW-1', 100);
  assert.equal(r.status, 'earned');
  assert.equal(r.held, true);
  assert.equal(svc(`select status from public.commissions where invoice_key='TW-1'`), 'held');
  // A person releases it.
  const id = svc(`select id from public.commissions where invoice_key='TW-1'`);
  assert.equal(svc(`select public.partner_resolve_held('${id}', true, 'checked, real customer')`), 'released');
  assert.equal(svc(`select public.partner_resolve_held('${id}', true)`), 'not_held');
});

test('accrue: a partner own card on the customer subscription holds it', { skip }, () => {
  newUser(400, 'cardcust@x.co');
  svc(`select public.partner_record_referral('${U(400)}', 'sara')`);
  psql(`insert into public.subscriptions (user_id, status, stripe_subscription_id) values ('${U(400)}', 'active', 'sub_card')`);
  psql(`insert into public.trial_card_ledger values ('fp1', '${PARTNER_USER}', 'sub_card')`);
  const r = accrue(U(400), 'CARD-1', 100);
  assert.equal(r.held, true);
  assert.match(svc(`select note from public.commissions where invoice_key='CARD-1'`), /same_card/);
});

test('accrue: more than 5 first payments in a week is a velocity hold', { skip }, () => {
  newPartner('fast', 'fast@x.co');
  for (let i = 0; i < 7; i++) {
    const n = 500 + i;
    newUser(n, `fast${i}@x.co`);
    svc(`select public.partner_record_referral('${U(n)}', 'fast')`);
  }
  const held: boolean[] = [];
  for (let i = 0; i < 7; i++) held.push(accrue(U(500 + i), `FAST-${i}`, 100).held);
  // Five first payments are fine; the sixth in the same week is the one over the cap.
  assert.deepEqual(held, [false, false, false, false, false, true, true]);
});

test('void: unpaid is voided, partial refund holds, repeat is harmless', { skip }, () => {
  assert.equal(svc(`select public.partner_void_invoice('NOPE', 'refund', true)`), 'no_commission');
  assert.equal(svc(`select public.partner_void_invoice('INV-2', 'half refund', false)`), 'held');
  assert.equal(svc(`select public.partner_void_invoice('INV-2', 'refund', true)`), 'voided');
  assert.equal(svc(`select public.partner_void_invoice('INV-2', 'refund', true)`), 'already');
  assert.equal(svc(`select status from public.commissions where invoice_key='INV-2'`), 'voided');
});

test('payout: minimum applies, paid once, clawback is netted off later payouts', { skip }, () => {
  newPartner('payme', 'payme@x.co');
  for (let i = 0; i < 5; i++) {
    newUser(600 + i, `pay${i}@x.co`);
    svc(`select public.partner_record_referral('${U(600 + i)}', 'payme')`);
  }
  const pay = () => JSON.parse(svc(`select public.partner_pay_out((select id from public.partners where code='payme'), 'SAR', 'bank_transfer', 'REF-1')`));
  const age = () => psql(`update public.commissions set payable_at = now() - interval '1 day' where status='pending' and partner_id=(select id from public.partners where code='payme')`);

  accrue(U(600), 'PAY-1', 100); // 25 SAR
  assert.equal(pay().status, 'nothing'); // still inside the hold
  age();
  assert.equal(pay().status, 'below_minimum');

  accrue(U(601), 'PAY-2', 1100); // 275 -> total 300
  age();
  const first = pay();
  assert.equal(first.status, 'paid');
  assert.equal(first.amount, 300);
  assert.equal(pay().status, 'nothing');
  assert.equal(svc(`select count(*) from public.commissions where status='paid' and partner_id=(select id from public.partners where code='payme')`), '2');

  // PAY-2 (275) is refunded after it was paid out: clawback, not a silent loss.
  assert.equal(svc(`select public.partner_void_invoice('PAY-2', 'chargeback', true)`), 'clawback');
  assert.equal(svc(`select status||'|'||needs_clawback from public.commissions where invoice_key='PAY-2'`), 'paid|true');

  accrue(U(602), 'PAY-3', 800); // 200 < 275 owed back
  age();
  assert.equal(pay().status, 'covered_by_clawback');
  accrue(U(603), 'PAY-4', 1400); // 350 -> 550 - 275 = 275 < minimum 300
  age();
  assert.equal(pay().status, 'below_minimum');
  accrue(U(604), 'PAY-5', 400); // 100 -> 650 - 275 = 375
  age();
  const last = pay();
  assert.equal(last.status, 'paid');
  assert.equal(last.amount, 375);
  assert.equal(svc(`select clawback_payout_id is not null from public.commissions where invoice_key='PAY-2'`), 't');
  assert.equal(pay().status, 'nothing');
  // The same clawback is never netted twice.
  accrue(U(600), 'PAY-6', 1300); // 325
  age();
  assert.equal(pay().amount, 325);
});

test('reconcile: earns invoices the webhook missed, and only once', { skip }, () => {
  newPartner('rec', 'rec@x.co');
  newUser(700, 'rec1@x.co');
  svc(`select public.partner_record_referral('${U(700)}', 'rec')`);
  psql(`insert into public.invoices (user_id, amount_sar, status, invoice_number, paid_at) values
    ('${U(700)}', 400, 'paid', 'REC-1', now()),
    ('${U(700)}', 0, 'paid', 'REC-0', now()),
    ('${U(700)}', 400, 'failed', 'REC-F', now()),
    ('${U(2)}', 400, 'paid', 'INV-1', now())`);
  const first = JSON.parse(svc('select public.partner_reconcile()'));
  assert.equal(first.earned, 1);
  assert.equal(svc(`select amount from public.commissions where invoice_key='REC-1'`), '100.00');
  assert.equal(JSON.parse(svc('select public.partner_reconcile()')).earned, 0);
  assert.equal(svc(`select count(*) from public.commissions where invoice_key in ('REC-0','REC-F')`), '0');
});
