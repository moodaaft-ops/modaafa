/**
 * The morning guard run: for every connected account of a billable owner,
 * read yesterday, apply the rules, keep the findings, and send one short
 * message per owner for what is new. Everything outside the rules (Google, the
 * database, the mail) comes in through `deps`, so a test runs it with fixtures.
 *
 * Nothing here changes a Google Ads account. A finding that needs a person
 * (suspension, billing, policy) is marked `escalation: human` and the mail says
 * to talk to the agency; no action is proposed or executed.
 */
import { excludeShadowAccounts } from '../shadow/guard';
import { shadowModeEnabled } from '../shadow/flag';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import { getBillableBusinessIds } from '@/lib/platform/jobs';
import { mapLimit } from '@/lib/platform/concurrency';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import { sendTemplate as realSendTemplate, type SendTemplateInput, type SendTemplateResult } from '@/lib/messaging/send';
import { detectAll, finalize, needsDiagnosisData } from './analyze';
import { isGuardEnabled, isGuardEnabledForUser } from './flag';
import { guardFactsFrom } from './notify';
import { createSupabaseGuardStore, reconcile, type GuardStore } from './persist';
import { loadSignals, withImpressionShare, type AccountRef, type GaqlReader } from './signals';
import { ymdInZone } from './time';
import type { GuardSignals, GuardSource } from './types';

export const GUARD_ACCOUNT_LIMIT = 200;
export const GUARD_CONCURRENCY = 3;
/** An account checked this recently is skipped by the later scheduler slots of the same day. */
export const GUARD_RECHECK_MS = 18 * 3_600_000;
const PAUSED_STATUSES = new Set(['SUSPENDED', 'CANCELED', 'CANCELLED', 'CLOSED', 'CUSTOMER_NOT_ENABLED']);

type AccountRow = {
  id: string;
  business_id: string;
  customer_id: string;
  customer_name: string | null;
  manager_id: string | null;
  currency_code: string | null;
  time_zone: string | null;
  refresh_token_encrypted: string;
  google_status: string | null;
  status: string;
  guard_checked_at: string | null;
};

type OwnerRow = { id: string; email: string; name: string | null; messages_opt_out: boolean | null };

export type GuardRunDeps = {
  supabase: any;
  env?: Record<string, string | undefined>;
  now?: Date;
  store?: GuardStore;
  /** Test seam: the Google Ads reader for one account. */
  openCustomer?: (account: AccountRow) => GaqlReader;
  /** Test seam: the billable business list. */
  billableBusinessIds?: () => Promise<string[]>;
  sendTemplate?: (input: SendTemplateInput) => Promise<SendTemplateResult>;
  budget?: { expired(reserveMs?: number): boolean };
};

export type GuardRunOptions = { accountId?: string | null; force?: boolean; limit?: number };

export type GuardRunSummary = {
  skipped?: 'disabled';
  accounts: { considered: number; checked: number; skippedRecent: number; skippedForTime: number; failed: number };
  findings: { opened: number; touched: number; resolved: number };
  mail: { owners: number; sent: number; skipped: Record<string, number>; failed: number };
  errors: Array<{ customer_id: string; message: string }>;
};

const emptySummary = (): GuardRunSummary => ({
  accounts: { considered: 0, checked: 0, skippedRecent: 0, skippedForTime: 0, failed: 0 },
  findings: { opened: 0, touched: 0, resolved: 0 },
  mail: { owners: 0, sent: 0, skipped: {}, failed: 0 },
  errors: [],
});

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function loadOwners(supabase: any, businessIds: string[]) {
  const ownerByBusiness = new Map<string, OwnerRow>();
  for (const ids of chunk(businessIds, 200)) {
    const { data: businesses, error } = await supabase.from('businesses').select('id, user_id').in('id', ids);
    if (error) throw new Error(`businesses read failed: ${error.message}`);
    const userIds = Array.from(new Set((businesses ?? []).map((b: any) => b.user_id).filter(Boolean)));
    if (userIds.length === 0) continue;
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, email, name, messages_opt_out')
      .in('id', userIds);
    if (usersError) throw new Error(`users read failed: ${usersError.message}`);
    const byId = new Map<string, OwnerRow>((users ?? []).map((u: any) => [u.id, u]));
    for (const business of businesses ?? []) {
      const owner = byId.get(business.user_id);
      if (owner?.email) ownerByBusiness.set(business.id, owner);
    }
  }
  return ownerByBusiness;
}

async function loadAccounts(supabase: any, businessIds: string[], accountId: string | null | undefined) {
  const rows: AccountRow[] = [];
  for (const ids of chunk(businessIds, 200)) {
    let query = supabase
      .from('google_ads_accounts')
      .select(
        'id, business_id, customer_id, customer_name, manager_id, currency_code, time_zone, refresh_token_encrypted, google_status, status, guard_checked_at'
      )
      .in('business_id', ids)
      .in('status', ['active', 'paused'])
      .not('is_manager', 'is', true)
      .order('guard_checked_at', { ascending: true, nullsFirst: true })
      .limit(1000);
    if (accountId) query = query.eq('id', accountId);
    const { data, error } = await query;
    if (error) throw new Error(`accounts read failed: ${error.message}`);
    rows.push(...((data ?? []) as AccountRow[]));
  }
  // A paused link is interesting only when Google itself says the account is dead; a revoked grant is the sync's business.
  return rows.filter((row) => row.status === 'active' || PAUSED_STATUSES.has(String(row.google_status ?? '').toUpperCase()));
}

function defaultOpenCustomer(account: AccountRow): GaqlReader {
  const refreshToken = decrypt(account.refresh_token_encrypted);
  return getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined) as unknown as GaqlReader;
}

/** A paused link whose account Google reports dead: only the stored status is known, nothing can be queried. */
function storedStatusSignals(account: AccountRow, ref: AccountRef, now: Date): GuardSignals {
  const none: Record<GuardSource, boolean> = { status: true, daily: false, campaigns: false, ads: false, billing: false, changes: false };
  const timeZone = ref.timeZone || 'Asia/Riyadh';
  const today = ymdInZone(now, timeZone);
  return {
    accountId: account.id,
    customerId: ref.customerId,
    currency: (ref.currency || 'SAR').toUpperCase(),
    timeZone,
    now,
    today,
    yesterday: today,
    googleStatus: String(account.google_status ?? 'CUSTOMER_NOT_ENABLED').toUpperCase(),
    daily: [],
    campaigns: [],
    ads: [],
    billing: null,
    changes: [],
    ownActions: [],
    ok: none,
  };
}

export async function runGuard(deps: GuardRunDeps, options: GuardRunOptions = {}): Promise<GuardRunSummary> {
  const env = deps.env ?? process.env;
  const summary = emptySummary();
  if (!isGuardEnabled(env)) return { ...summary, skipped: 'disabled' };

  const { supabase } = deps;
  const now = deps.now ?? new Date();
  const store = deps.store ?? createSupabaseGuardStore(supabase);
  const send = deps.sendTemplate ?? ((input: SendTemplateInput) => realSendTemplate(input));
  const openCustomer = deps.openCustomer ?? defaultOpenCustomer;
  const limit = Math.min(Math.max(options.limit ?? GUARD_ACCOUNT_LIMIT, 1), GUARD_ACCOUNT_LIMIT);

  const businessIds = await (deps.billableBusinessIds ?? (() => getBillableBusinessIds(supabase)))();
  if (businessIds.length === 0) return summary;
  const owners = await loadOwners(supabase, businessIds);
  // 'operators' mode: only the owners the flag allows are read at all.
  const allowed = businessIds.filter((id) => {
    const owner = owners.get(id);
    return owner ? isGuardEnabledForUser(owner.email, env) : false;
  });
  if (allowed.length === 0) return summary;

  // Agency shadow accounts are never checked or mailed (SHADOW_MODE_ENABLED; a no-op when off).
  const all = await excludeShadowAccounts(supabase, await loadAccounts(supabase, allowed, options.accountId), shadowModeEnabled(env as NodeJS.ProcessEnv));
  summary.accounts.considered = all.length;
  const due = all.filter((row) => {
    if (options.force || options.accountId) return true;
    if (!row.guard_checked_at) return true;
    return now.getTime() - new Date(row.guard_checked_at).getTime() >= GUARD_RECHECK_MS;
  });
  summary.accounts.skippedRecent = all.length - due.length;
  const batch = due.slice(0, limit);

  const checkedByBusiness = new Map<string, string[]>();
  const accountNames = new Map<string, string | null>();

  await mapLimit(batch, GUARD_CONCURRENCY, async (account) => {
    if (deps.budget?.expired(30_000)) {
      summary.accounts.skippedForTime += 1;
      return;
    }
    const ref: AccountRef = {
      id: account.id,
      customerId: account.customer_id.replace(/\D/g, ''),
      currency: account.currency_code,
      timeZone: account.time_zone,
      storedGoogleStatus: account.google_status,
    };
    try {
      let signals: GuardSignals;
      let customer: GaqlReader | null = null;
      if (account.status === 'paused') {
        signals = storedStatusSignals(account, ref, now);
      } else {
        customer = openCustomer(account);
        signals = await loadSignals({ account: ref, customer, supabase, now });
      }
      const detected = detectAll(signals);
      if (customer && needsDiagnosisData(detected.findings)) signals = await withImpressionShare(signals, customer);
      const findings = finalize(detected, signals);

      const existing = await store.loadExisting(account.id);
      const plan = reconcile(existing, findings, signals.ok);
      await store.apply({ accountId: account.id, businessId: account.business_id, plan, now });
      summary.findings.opened += plan.upsert.length;
      summary.findings.touched += plan.touch.length;
      summary.findings.resolved += plan.resolve.length;
      summary.accounts.checked += 1;
      checkedByBusiness.set(account.business_id, [...(checkedByBusiness.get(account.business_id) ?? []), account.id]);
      accountNames.set(account.id, account.customer_name);

      // Best effort: the column arrives with the migration; a miss only means the account is checked again next slot.
      const { error } = await supabase.from('google_ads_accounts').update({ guard_checked_at: now.toISOString() }).eq('id', account.id);
      if (error) console.warn('guard_checked_at not stamped', error.message);
    } catch (error) {
      summary.accounts.failed += 1;
      summary.errors.push({ customer_id: account.customer_id, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }
  });

  // One message per owner, built from what is open and not yet told.
  for (const [businessId, accountIds] of checkedByBusiness) {
    const owner = owners.get(businessId);
    if (!owner) continue;
    try {
      const rows = await store.listNotifiable(accountIds, now);
      const facts = guardFactsFrom(
        rows.map((row) => ({ ...row, account_name: accountNames.get(row.account_id) ?? null })),
        accountIds.length > 1
      );
      if (!facts) continue;
      summary.mail.owners += 1;
      // The (user, template) claim makes this at most one guard mail per owner per Riyadh day.
      const result = await send({
        user: { id: owner.id, email: owner.email, name: owner.name, messages_opt_out: owner.messages_opt_out },
        templateKey: `guard_alert_${ymdInZone(now, 'Asia/Riyadh')}`,
        copy: EMAIL_COPY.guard_alert,
        facts: { firstName: null, businessName: null, plan: null, trial: null, weekly: null, billing: null, guard: facts },
        enforceGap: false,
      });
      if (result.status === 'sent') {
        summary.mail.sent += 1;
        await store.markNotified(rows.map((row) => row.id), now);
      } else if (result.status === 'failed') {
        summary.mail.failed += 1;
      } else {
        const reason = result.status === 'skipped' ? result.reason : result.status;
        summary.mail.skipped[reason] = (summary.mail.skipped[reason] ?? 0) + 1;
      }
    } catch (error) {
      summary.mail.failed += 1;
      summary.errors.push({ customer_id: businessId, message: `mail: ${(error instanceof Error ? error.message : String(error)).slice(0, 250)}` });
    }
  }
  return summary;
}
