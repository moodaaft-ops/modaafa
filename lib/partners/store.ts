import { commissionBaseMinor } from './invoice-base';
import { minorUnitsToAmount } from '@/lib/billing/invoices';
import { normalizePartnerCode } from './config';

/**
 * Every partner read and write goes through here, always with the service-role
 * client: the partner tables are closed to the browser. The money rules
 * themselves are SQL functions (db/migrations/20261019_partner_program.sql); this
 * file only calls them, so a retry or a second worker cannot earn the same
 * invoice twice.
 */

type Db = any;

function check<T>(label: string, result: { data: T; error: unknown }): T {
  if (result.error) throw new Error(`partners: ${label} failed`, { cause: result.error });
  return result.data;
}

export type ReferralResult =
  | 'recorded' | 'already' | 'switched' | 'locked' | 'self' | 'unknown_code'
  | 'inactive' | 'no_user' | 'bad_via';

export async function recordPartnerClick(db: Db, code: string, visitorHashValue: string, path: string | null) {
  const result = await db.rpc('partner_record_click', { p_code: code, p_visitor_hash: visitorHashValue, p_path: path });
  return check('record click', result) as 'recorded' | 'duplicate' | 'unknown';
}

export async function recordPartnerReferral(db: Db, userId: string, rawCode: string, via: 'link' | 'code' | 'ops') {
  const code = normalizePartnerCode(rawCode);
  if (!code) return 'unknown_code' as ReferralResult;
  const result = await db.rpc('partner_record_referral', { p_user_id: userId, p_code: code, p_via: via });
  return check('record referral', result) as ReferralResult;
}

export type AccrueOutcome = {
  status: 'earned' | 'duplicate' | 'no_referral' | 'expired' | 'zero' | 'inactive' | 'bad_invoice';
  amount?: number;
  held?: boolean;
};

/**
 * Earn a commission from a Stripe invoice that moved money. The key is the same
 * one recordPaidInvoice stores (`number ?? id`), which is what lets the reconcile
 * sweep and the webhook share one idempotency key.
 */
export async function accrueInvoiceCommission(db: Db, params: { userId: string; invoice: any }): Promise<AccrueOutcome> {
  const { invoice } = params;
  const key = invoice?.number ?? invoice?.id;
  const baseMinor = commissionBaseMinor(invoice ?? {});
  if (!key) return { status: 'bad_invoice' };
  if (baseMinor <= 0) return { status: 'zero' };
  const paidUnix = invoice.status_transitions?.paid_at ?? invoice.created ?? null;
  const result = await db.rpc('partner_accrue_commission', {
    p_user_id: params.userId,
    p_invoice_key: String(key),
    p_net: minorUnitsToAmount(baseMinor, invoice.currency),
    p_currency: String(invoice.currency ?? 'sar').toUpperCase(),
    p_paid_at: paidUnix ? new Date(paidUnix * 1000).toISOString() : new Date().toISOString(),
  });
  return check('accrue commission', result) as AccrueOutcome;
}

/** `fraction` is the share of the invoice refunded: 1 for a full refund or a dispute. */
export async function voidInvoiceCommission(db: Db, invoiceKey: string, reason: string, fraction: number) {
  const result = await db.rpc('partner_void_invoice', { p_invoice_key: invoiceKey, p_reason: reason, p_fraction: fraction });
  return check('void commission', result) as string;
}

/** The referrer of a user who has not paid yet, for the referee gift at checkout. */
export async function openReferralFor(db: Db, userId: string): Promise<{ code: string } | null> {
  const row = check(
    'read referral',
    await db
      .from('referrals')
      .select('code_used, first_paid_at, status, partners(status)')
      .eq('referred_user_id', userId)
      .maybeSingle(),
  ) as { code_used: string; first_paid_at: string | null; status: string; partners: { status: string } | null } | null;
  // No gift for someone whose partner is paused or banned.
  if (!row || row.first_paid_at || row.status === 'rejected' || row.partners?.status !== 'active') return null;
  return { code: row.code_used };
}

export type PartnerRow = {
  id: string;
  user_id: string | null;
  code: string;
  display_name: string;
  email: string;
  phone: string | null;
  status: 'invited' | 'active' | 'paused' | 'banned';
  commission_rate: number | null;
  commission_months: number | null;
  payout_method: string | null;
  payout_details: string | null;
  created_at: string;
};

const PARTNER_COLUMNS =
  'id, user_id, code, display_name, email, phone, status, commission_rate, commission_months, payout_method, payout_details, created_at';

/**
 * The partner row for a signed-in user: by account, or by the email the partner
 * was invited with (and then linked, once, so later visits match by account).
 * The email on an authenticated user is a confirmed one: they signed in by code.
 */
export async function findPartnerForUser(db: Db, user: { id: string; email: string | null }): Promise<PartnerRow | null> {
  const byUser = check('find partner', await db.from('partners').select(PARTNER_COLUMNS).eq('user_id', user.id).maybeSingle()) as PartnerRow | null;
  if (byUser) return byUser;
  if (!user.email) return null;
  // An exact match on the lower-cased address (createPartner stores it that way).
  // Never a pattern match: `_` and `%` in an address are wildcards to ilike.
  const byEmail = check(
    'find partner by email',
    await db.from('partners').select(PARTNER_COLUMNS).eq('email', user.email.trim().toLowerCase()).is('user_id', null).maybeSingle(),
  ) as PartnerRow | null;
  if (!byEmail) return null;
  const linked = await db
    .from('partners')
    .update({ user_id: user.id, updated_at: new Date().toISOString() })
    .eq('id', byEmail.id)
    .is('user_id', null)
    .select('id');
  // Someone else linked it first, or the link failed: not theirs.
  if (linked.error || !Array.isArray(linked.data) || linked.data.length !== 1) return null;
  return { ...byEmail, user_id: user.id };
}

export type Money = Record<string, number>;
export type PartnerSummary = {
  clicks30: number;
  signups: number;
  paying: number;
  pending: Money;
  payable: Money;
  held: Money;
  paid: Money;
  clawback: Money;
  recent: Array<{ invoice_key: string; currency: string; amount: number; status: string; earned_at: string; payable_at: string }>;
  payouts: Array<{ id: string; currency: string; amount: number; method: string | null; created_at: string }>;
};

function add(into: Money, currency: string, amount: number) {
  into[currency] = Math.round(((into[currency] ?? 0) + amount) * 100) / 100;
}

export async function partnerSummary(db: Db, partnerId: string, now = new Date()): Promise<PartnerSummary> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [clicks, referrals, commissions, payouts] = await Promise.all([
    db.from('referral_clicks').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId).gte('clicked_at', since),
    db.from('referrals').select('status').eq('partner_id', partnerId).neq('status', 'rejected'),
    db
      .from('commissions')
      .select('invoice_key, currency, amount, status, earned_at, payable_at, needs_clawback, clawback_amount, clawback_payout_id')
      .eq('partner_id', partnerId)
      .order('earned_at', { ascending: false })
      .limit(500),
    db.from('payouts').select('id, currency, amount, method, created_at').eq('partner_id', partnerId).order('created_at', { ascending: false }).limit(50),
  ]);
  check('count clicks', clicks);
  const refRows = check('read referrals', referrals) as Array<{ status: string }>;
  const rows = check('read commissions', commissions) as Array<any>;
  const summary: PartnerSummary = {
    clicks30: clicks.count ?? 0,
    signups: refRows.length,
    paying: refRows.filter((r) => r.status === 'paying').length,
    pending: {}, payable: {}, held: {}, paid: {}, clawback: {},
    recent: rows.slice(0, 20).map((r) => ({
      invoice_key: r.invoice_key, currency: r.currency, amount: Number(r.amount),
      status: r.status, earned_at: r.earned_at, payable_at: r.payable_at,
    })),
    payouts: (check('read payouts', payouts) as Array<any>).map((p) => ({ ...p, amount: Number(p.amount) })),
  };
  for (const r of rows) {
    const amount = Number(r.amount);
    if (r.status === 'pending') add(new Date(r.payable_at) <= now ? summary.payable : summary.pending, r.currency, amount);
    else if (r.status === 'held') add(summary.held, r.currency, amount);
    else if (r.status === 'paid') add(summary.paid, r.currency, amount);
    if (r.needs_clawback && !r.clawback_payout_id) add(summary.clawback, r.currency, Number(r.clawback_amount ?? r.amount));
  }
  return summary;
}

export type PartnerListRow = PartnerRow & {
  clicks: number; signups: number; paying: number; payable: Money; owed_clawback: Money; held_count: number;
};

/** Everything the ops page lists, in a few queries rather than one per partner. */
export async function listPartners(db: Db, now = new Date()): Promise<PartnerListRow[]> {
  const partners = check('list partners', await db.from('partners').select(PARTNER_COLUMNS).order('created_at', { ascending: false })) as PartnerRow[];
  if (partners.length === 0) return [];
  const [refs, coms, clicks] = await Promise.all([
    db.from('referrals').select('partner_id, status').neq('status', 'rejected').limit(20000),
    db.from('commissions').select('partner_id, currency, amount, status, payable_at, needs_clawback, clawback_amount, clawback_payout_id').limit(20000),
    db.from('referral_clicks').select('partner_id').gte('clicked_at', new Date(now.getTime() - 30 * 86_400_000).toISOString()).limit(50000),
  ]);
  const refRows = check('list referrals', refs) as Array<{ partner_id: string; status: string }>;
  const comRows = check('list commissions', coms) as Array<any>;
  const clickRows = check('list clicks', clicks) as Array<{ partner_id: string }>;
  return partners.map((p) => {
    const mine = refRows.filter((r) => r.partner_id === p.id);
    const payable: Money = {};
    const owed: Money = {};
    let held = 0;
    for (const c of comRows.filter((x) => x.partner_id === p.id)) {
      const amount = Number(c.amount);
      if (c.status === 'pending' && new Date(c.payable_at) <= now) add(payable, c.currency, amount);
      if (c.status === 'held') held += 1;
      if (c.needs_clawback && !c.clawback_payout_id) add(owed, c.currency, Number(c.clawback_amount ?? amount));
    }
    return {
      ...p,
      clicks: clickRows.filter((c) => c.partner_id === p.id).length,
      signups: mine.length,
      paying: mine.filter((r) => r.status === 'paying').length,
      payable, owed_clawback: owed, held_count: held,
    };
  });
}

export type HeldCommission = {
  id: string; partner_code: string; invoice_key: string; currency: string; amount: number; note: string | null; earned_at: string;
};

export async function listHeldCommissions(db: Db): Promise<HeldCommission[]> {
  const rows = check(
    'list held',
    await db
      .from('commissions')
      .select('id, invoice_key, currency, amount, note, earned_at, partners(code)')
      .eq('status', 'held')
      .order('earned_at', { ascending: true })
      .limit(100),
  ) as Array<any>;
  return rows.map((r) => ({
    id: r.id, partner_code: r.partners?.code ?? '?', invoice_key: r.invoice_key,
    currency: r.currency, amount: Number(r.amount), note: r.note, earned_at: r.earned_at,
  }));
}

export async function createPartner(
  db: Db,
  input: { code: string; displayName: string; email: string; phone?: string | null; commissionRate?: number | null },
) {
  const code = normalizePartnerCode(input.code);
  if (!code) return { ok: false as const, error: 'bad_code' as const };
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false as const, error: 'bad_email' as const };
  const name = input.displayName.trim();
  if (name.length < 2 || name.length > 80) return { ok: false as const, error: 'bad_name' as const };
  const { error } = await db.from('partners').insert({
    code, display_name: name, email, phone: input.phone?.trim() || null,
    commission_rate: input.commissionRate ?? null, status: 'active',
  });
  if (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false as const, error: 'duplicate' as const };
    throw new Error('partners: create partner failed', { cause: error });
  }
  return { ok: true as const, code };
}

export async function setPartnerStatus(db: Db, partnerId: string, status: PartnerRow['status']) {
  check('set status', await db.from('partners').update({ status, updated_at: new Date().toISOString() }).eq('id', partnerId));
}

export async function resolveHeldCommission(db: Db, id: string, release: boolean, note: string | null) {
  const result = await db.rpc('partner_resolve_held', { p_commission_id: id, p_release: release, p_note: note });
  return check('resolve held', result) as string;
}

export async function payOutPartner(
  db: Db,
  params: { partnerId: string; currency: string; method: string; reference: string; note?: string | null; paidBy: string; expectedNet?: number | null },
) {
  const result = await db.rpc('partner_pay_out', {
    p_partner_id: params.partnerId, p_currency: params.currency, p_method: params.method,
    p_reference: params.reference, p_note: params.note ?? null, p_paid_by: params.paidBy, p_expected: params.expectedNet ?? null,
  });
  return check('pay out', result) as { status: string; amount?: number; gross?: number; clawback?: number; net?: number; minimum?: number; expected?: number };
}

/**
 * Small batches, each its own transaction: a long sweep would hold customer rows
 * a billing webhook may need. Stops when a batch comes back short.
 */
export async function reconcilePartnerCommissions(db: Db, batch = 50, maxBatches = 10) {
  let checked = 0;
  let earned = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = check('reconcile', await db.rpc('partner_reconcile', { p_limit: batch })) as { checked: number; earned: number };
    checked += result.checked;
    earned += result.earned;
    if (result.checked < batch) break;
  }
  return { checked, earned };
}

export type PartnerSettings = {
  default_rate: number; tier_rate: number; tier_threshold: number; commission_months: number;
  hold_days: number; min_payout: number; velocity_cap: number;
};

export async function readPartnerSettings(db: Db): Promise<PartnerSettings> {
  const row = check('read settings', await db.from('partner_settings').select('*').eq('singleton', true).maybeSingle()) as Record<string, unknown> | null;
  if (!row) throw new Error('partners: settings row missing');
  return {
    default_rate: Number(row.default_rate), tier_rate: Number(row.tier_rate), tier_threshold: Number(row.tier_threshold),
    commission_months: Number(row.commission_months), hold_days: Number(row.hold_days),
    min_payout: Number(row.min_payout), velocity_cap: Number(row.velocity_cap),
  };
}
