/**
 * Loads what the operations center shows, with the service role. Server only.
 *
 * Volumes today are a few hundred customers, so the overview loads the whole
 * customer base and computes in memory (operator-insights.ts). Every table read
 * is paged (PostgREST caps a response at 1000 rows) and capped, so a much
 * larger base degrades to "the newest N" instead of timing out.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { assertSupabaseRead } from '@/lib/supabase/query-errors';
import { getPlanPriceAmounts } from '@/lib/billing/stripe';
import { parseModaafaOperatorEmails } from '@/lib/platform/operators';
import { DAY_MS, type OperatorDataset, type Row } from '@/lib/platform/operator-insights';

const PAGE = 1000;
const MAX_PAGES = 50;

const FALLBACK_MONTHLY_PRICES = { starter: 500, growth: 1200, pro: 2500 } as const;

/** Tables added by 20261012_operator_console.sql; missing before it runs. */
const OPTIONAL_TABLES = new Set(['account_access_overrides', 'operator_audit_log']);

/**
 * Read every row in pages. The caller's ordering gets a unique tie-break
 * column appended, so offset paging cannot skip or repeat rows that share a
 * timestamp. Hitting the page cap is recorded in `truncated` and shown on the
 * page, instead of silently undercounting.
 */
async function pagedSelect(
  admin: any,
  table: string,
  build: (query: any) => any,
  unavailable: string[],
  truncated: string[] = [],
  tieBreak = 'id'
) {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await build(admin.from(table))
      .order(tieBreak, { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (OPTIONAL_TABLES.has(table)) {
        unavailable.push(table);
        return [];
      }
      assertSupabaseRead(error, `operations: load ${table}`);
    }
    const chunk = (data ?? []) as Row[];
    rows.push(...chunk);
    if (chunk.length < PAGE) return rows;
  }
  truncated.push(table);
  return rows;
}

async function loadAuthFacts(admin: any) {
  const facts: OperatorDataset['auth'] = {};
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) {
      // Not fatal: profiles fall back to users.last_login_at.
      console.error('operations: auth user list unavailable', error.message);
      break;
    }
    const users = (data?.users ?? []) as Array<Record<string, any>>;
    for (const user of users) {
      facts[user.id] = {
        email_confirmed_at: user.email_confirmed_at ?? user.confirmed_at ?? null,
        last_sign_in_at: user.last_sign_in_at ?? null,
      };
    }
    if (users.length < PAGE) break;
  }
  return facts;
}

export async function loadPlanPrices(): Promise<Pick<OperatorDataset, 'monthlyPrices' | 'yearlyPrices'>> {
  const live = await getPlanPriceAmounts().catch(() => null);
  return {
    monthlyPrices: {
      starter: live?.starter?.monthly?.amount ?? FALLBACK_MONTHLY_PRICES.starter,
      growth: live?.growth?.monthly?.amount ?? FALLBACK_MONTHLY_PRICES.growth,
      pro: live?.pro?.monthly?.amount ?? FALLBACK_MONTHLY_PRICES.pro,
    },
    yearlyPrices: {
      starter: live?.starter?.yearly?.amount ?? null,
      growth: live?.growth?.yearly?.amount ?? null,
      pro: live?.pro?.yearly?.amount ?? null,
    },
  };
}

/** Everything the overview and the customer list need. */
export async function loadOperatorDataset(now = Date.now()): Promise<OperatorDataset> {
  const admin = createAdminClient();
  const unavailable: string[] = [];
  const truncated: string[] = [];
  const monthAgo = new Date(now - 30 * DAY_MS).toISOString();
  const weekAgo = new Date(now - 7 * DAY_MS).toISOString();

  const [
    users,
    auth,
    businesses,
    accounts,
    subscriptions,
    audits,
    overrides,
    invoices,
    usage,
    recommendations,
    actions,
    jobs,
    webhooks,
    auditLog,
    prices,
  ] = await Promise.all([
    pagedSelect(admin, 'users', (q) => q.select('id, email, name, phone, created_at, last_login_at').order('created_at', { ascending: false }), unavailable, truncated),
    loadAuthFacts(admin),
    pagedSelect(admin, 'businesses', (q) => q.select('id, user_id, name, sector, website, created_at').order('id'), unavailable, truncated),
    pagedSelect(
      admin,
      'google_ads_accounts',
      (q) =>
        q
          .select('id, business_id, customer_id, customer_name, status, is_manager, google_status, linked_at, last_synced_at, last_optimized_at')
          .order('id'),
      unavailable,
      truncated
    ),
    pagedSelect(
      admin,
      'subscriptions',
      (q) =>
        q
          .select('user_id, plan, billing_period, status, trial_ends_at, current_period_start, current_period_end, created_at, canceled_at, stripe_subscription_id')
          .order('created_at', { ascending: false }),
      unavailable,
      truncated
    ),
    pagedSelect(admin, 'audits', (q) => q.select('account_id, ran_at').order('ran_at', { ascending: false }), unavailable, truncated),
    pagedSelect(
      admin,
      'account_access_overrides',
      (q) => q.select('user_id, kind, plan, expires_at, created_at, revoked_at').order('created_at', { ascending: false }),
      unavailable,
      truncated
    ),
    pagedSelect(admin, 'invoices', (q) => q.select('user_id, status, amount_sar, currency, paid_at, created_at').order('created_at', { ascending: false }), unavailable, truncated),
    pagedSelect(
      admin,
      'usage_events',
      (q) => q.select('user_id, feature, created_at').gte('created_at', monthAgo).order('created_at', { ascending: false }),
      unavailable,
      truncated
    ),
    pagedSelect(
      admin,
      'recommendations',
      (q) =>
        q
          .select('account_id, status, severity, created_at, applied_at, execution_started_at')
          .or(`created_at.gte."${monthAgo}",status.eq.pending,status.eq.executing`)
          .order('created_at', { ascending: false }),
      unavailable,
      truncated
    ),
    pagedSelect(
      admin,
      'ai_actions',
      (q) => q.select('account_id, created_at, rollback_status, reverted_at').gte('created_at', monthAgo).order('created_at', { ascending: false }),
      unavailable,
      truncated
    ),
    pagedSelect(
      admin,
      'job_runs',
      (q) =>
        q
          .select('id, job_name, status, started_at, finished_at, duration_ms, processed, error_count, error_message')
          .gte('started_at', weekAgo)
          .order('started_at', { ascending: false }),
      unavailable,
      truncated
    ),
    pagedSelect(
      admin,
      'processed_webhook_events',
      (q) =>
        q
          .select('event_id, event_type, status, attempts, last_attempt_at, error_message')
          .eq('status', 'failed')
          .gte('last_attempt_at', weekAgo)
          .order('last_attempt_at', { ascending: false }),
      unavailable,
      truncated,
      'event_id'
    ),
    admin
      .from('operator_audit_log')
      .select('id, operator_email, action, target_user_id, status, reason, details, error_message, created_at')
      .order('created_at', { ascending: false })
      .limit(15)
      .then(({ data, error }: any) => {
        if (error) {
          unavailable.push('operator_audit_log');
          return [];
        }
        return (data ?? []) as Row[];
      }),
    loadPlanPrices(),
  ]);

  return {
    users,
    auth,
    businesses,
    accounts,
    subscriptions,
    audits,
    overrides,
    invoices,
    usage,
    recommendations,
    actions,
    jobs,
    webhooks,
    auditLog,
    operatorEmails: parseModaafaOperatorEmails(),
    ...prices,
    unavailable: Array.from(new Set(unavailable)),
    truncated: Array.from(new Set(truncated)),
  };
}

export type CustomerDetail = {
  dataset: OperatorDataset;
  accounts: Row[];
  subscriptions: Row[];
  invoices: Row[];
  recommendations: Row[];
  actions: Row[];
  usageByFeature: Record<string, number>;
  auditLog: Row[];
  overrideHistory: Row[];
  chatSessions: number;
};

/** One customer, everything about them. Null when the user does not exist. */
export async function loadCustomerDetail(userId: string, now = Date.now()): Promise<CustomerDetail | null> {
  const admin = createAdminClient();
  const unavailable: string[] = [];
  const monthAgo = new Date(now - 30 * DAY_MS).toISOString();

  const { data: user, error: userError } = await admin
    .from('users')
    .select('id, email, name, phone, created_at, last_login_at')
    .eq('id', userId)
    .maybeSingle();
  assertSupabaseRead(userError, 'operations: load customer');
  if (!user) return null;

  const [{ data: businesses, error: businessError }, authResult] = await Promise.all([
    admin.from('businesses').select('id, user_id, name, sector, website, created_at, primary_goal, monthly_budget').eq('user_id', userId),
    admin.auth.admin.getUserById(userId),
  ]);
  assertSupabaseRead(businessError, 'operations: load customer business');
  const businessIds = (businesses ?? []).map((row: Row) => row.id);

  const accounts = businessIds.length
    ? await pagedSelect(
        admin,
        'google_ads_accounts',
        (q) =>
          q
            .select('id, business_id, customer_id, customer_name, status, is_manager, google_status, linked_at, last_synced_at, last_sync_attempt_at, last_optimized_at, currency_code')
            .in('business_id', businessIds)
            .order('linked_at', { ascending: true }),
        unavailable
      )
    : [];
  const accountIds = accounts.map((row) => row.id);

  const [subscriptions, invoices, overrides, usage, audits, recommendations, actions, auditLogResult, chatResult, prices] =
    await Promise.all([
      pagedSelect(
        admin,
        'subscriptions',
        (q) =>
          q
            .select('id, user_id, plan, billing_period, status, trial_ends_at, current_period_start, current_period_end, created_at, canceled_at, stripe_subscription_id')
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),
        unavailable
      ),
      pagedSelect(
        admin,
        'invoices',
        (q) => q.select('user_id, status, amount_sar, currency, invoice_number, paid_at, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        unavailable
      ),
      pagedSelect(
        admin,
        'account_access_overrides',
        (q) => q.select('user_id, kind, plan, expires_at, created_at, revoked_at').eq('user_id', userId).order('created_at', { ascending: false }),
        unavailable
      ),
      pagedSelect(
        admin,
        'usage_events',
        (q) => q.select('user_id, feature, created_at').eq('user_id', userId).gte('created_at', monthAgo).order('created_at', { ascending: false }),
        unavailable
      ),
      accountIds.length
        ? pagedSelect(admin, 'audits', (q) => q.select('account_id, ran_at, health_score').in('account_id', accountIds).order('ran_at', { ascending: false }), unavailable)
        : Promise.resolve([]),
      accountIds.length
        ? admin
            .from('recommendations')
            .select('id, account_id, title, status, severity, category, created_at, applied_at, execution_started_at')
            .in('account_id', accountIds)
            .order('created_at', { ascending: false })
            .limit(60)
            .then(({ data, error }: any) => {
              assertSupabaseRead(error, 'operations: load customer recommendations');
              return (data ?? []) as Row[];
            })
        : Promise.resolve([]),
      accountIds.length
        ? admin
            .from('ai_actions')
            .select('id, account_id, action_type, description_ar, created_at, rollback_status, reverted_at')
            .in('account_id', accountIds)
            .order('created_at', { ascending: false })
            .limit(20)
            .then(({ data, error }: any) => {
              assertSupabaseRead(error, 'operations: load customer actions');
              return (data ?? []) as Row[];
            })
        : Promise.resolve([]),
      admin
        .from('operator_audit_log')
        .select('id, operator_email, action, status, reason, details, error_message, created_at')
        .eq('target_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(30),
      admin.from('chat_sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      loadPlanPrices(),
    ]);

  const usageByFeature: Record<string, number> = {};
  for (const event of usage) usageByFeature[event.feature] = (usageByFeature[event.feature] ?? 0) + 1;

  const authUser = (authResult as any)?.data?.user ?? null;
  const dataset: OperatorDataset = {
    users: [user as Row],
    auth: authUser
      ? {
          [userId]: {
            email_confirmed_at: authUser.email_confirmed_at ?? authUser.confirmed_at ?? null,
            last_sign_in_at: authUser.last_sign_in_at ?? null,
          },
        }
      : {},
    businesses: (businesses ?? []) as Row[],
    accounts,
    subscriptions,
    audits,
    overrides,
    invoices,
    usage,
    recommendations,
    actions,
    jobs: [],
    webhooks: [],
    auditLog: [],
    operatorEmails: parseModaafaOperatorEmails(),
    ...prices,
    unavailable: Array.from(new Set([...unavailable, ...(auditLogResult.error ? ['operator_audit_log'] : [])])),
  };

  return {
    dataset,
    accounts,
    subscriptions,
    invoices,
    recommendations,
    actions,
    usageByFeature,
    auditLog: (auditLogResult.data ?? []) as Row[],
    overrideHistory: overrides,
    chatSessions: chatResult.count ?? 0,
  };
}
