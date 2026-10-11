// Account isolation + free-audit quota against the real local Auth and REST (18 checks).
// Synthetic users only. Run through verify.sh so the env is loaded.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const password = `Loc-${Math.random().toString(36).slice(2)}Aa1!`;

let failures = 0;
let total = 0;
function check(name, ok, note = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  [${note}]` : ''}`);
}

async function makeUser(tag) {
  const email = `synthetic-${tag}-${Date.now()}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(url, anonKey, opts);
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const business = await admin.from('businesses').insert({ user_id: created.data.user.id, name: `synthetic business ${tag}`, sector: 'test' }).select().single();
  if (business.error) throw business.error;
  // The quota is keyed by Google Ads customer id, so every run uses a fresh random one.
  const customerId = String(Math.floor(1e9 + Math.random() * 9e9));
  const account = await admin
    .from('google_ads_accounts')
    .insert({ business_id: business.data.id, customer_id: customerId, customer_name: `synthetic account ${tag}`, refresh_token_encrypted: 'synthetic-not-a-token' })
    .select()
    .single();
  if (account.error) throw account.error;
  return { id: created.data.user.id, email, client, business: business.data, account: account.data };
}

const A = await makeUser('A');
const B = await makeUser('B');
const rows = (result) => result.data ?? [];

check('public.users row created by the auth trigger', rows(await admin.from('users').select('id').in('id', [A.id, B.id])).length === 2);
for (const table of ['businesses', 'google_ads_accounts', 'users']) {
  const result = await A.client.from(table).select('*');
  const leaked = rows(result).filter((row) => JSON.stringify(row).includes(B.id) || row.id === B.business.id || row.id === B.account.id);
  check(`A reads only its own rows in ${table}`, !result.error && leaked.length === 0, `rows=${rows(result).length}`);
}
const anon = createClient(url, anonKey, opts);
for (const table of ['businesses', 'google_ads_accounts', 'users', 'subscriptions']) {
  const result = await anon.from(table).select('*');
  check(`anon sees nothing in ${table}`, rows(result).length === 0, result.error?.code ?? 'rls');
}
let r = await A.client.from('businesses').update({ name: 'hacked' }).eq('id', B.business.id).select();
check('A cannot update the business of B', rows(r).length === 0);
r = await A.client.from('google_ads_accounts').update({ customer_name: 'hacked' }).eq('id', B.account.id).select();
check('A cannot update the ad account of B', rows(r).length === 0);
r = await A.client.from('google_ads_accounts').insert({ business_id: B.business.id, customer_id: '1111111111', refresh_token_encrypted: 'x' }).select();
check('A cannot attach an account to the business of B', Boolean(r.error) || rows(r).length === 0, r.error?.code ?? '');
r = await A.client.from('businesses').delete().eq('id', B.business.id).select();
check('A cannot delete the business of B', rows(r).length === 0);

r = await A.client.rpc('consume_free_audit', { p_account_id: B.account.id });
check('A cannot consume the free audit of the account of B', r.data?.[0]?.allowed === false || Boolean(r.error), JSON.stringify(r.data?.[0] ?? r.error?.code));
r = await A.client.rpc('consume_free_audit', { p_account_id: A.account.id });
const first = r.data?.[0];
check('A first free audit is allowed', first?.allowed === true, JSON.stringify({ allowed: first?.allowed, used: first?.used }));
r = await A.client.rpc('consume_free_audit', { p_account_id: A.account.id });
check('a second consume while one is running is not a new charge', r.data?.[0]?.allowed === false, JSON.stringify({ reason: r.data?.[0]?.reason, used: r.data?.[0]?.used }));
r = await A.client.rpc('complete_free_audit', { p_event_id: first?.event_id, p_user_id: A.id, p_account_id: A.account.id });
check('a signed-in user cannot call complete_free_audit', Boolean(r.error), r.error?.code ?? '');
r = await admin.rpc('complete_free_audit', { p_event_id: first?.event_id, p_user_id: A.id, p_account_id: A.account.id });
check('the service role completes the free audit', !r.error, r.error?.message?.slice(0, 60) ?? '');
r = await B.client.rpc('consume_free_audit', { p_account_id: B.account.id });
check('B has an independent free audit', r.data?.[0]?.allowed === true, JSON.stringify({ allowed: r.data?.[0]?.allowed, used: r.data?.[0]?.used }));

const stateDir = path.resolve(process.cwd(), '.local-stack');
fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify({ A: A.id, B: B.id, emailA: A.email, emailB: B.email, password }), { mode: 0o600 });
console.log(`${failures} failures of ${total}`);
process.exit(failures === 0 && total === 18 ? 0 : 1);
