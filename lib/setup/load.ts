import { getAccountWorkspace, normalizeCustomerId } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName, googleAdsAccountNameMissing } from '@/lib/accounts/display';
import { accountStatusView, sortAccountsBySpend } from '@/lib/onboarding/account-choice';
import {
  connectJobName,
  resolveConnectProgress,
  type ConnectJobDetails,
  type ConnectJobSnapshot,
  type ConnectPhase,
} from '@/lib/onboarding/connect-progress';
import { firstFindings, type OpportunityRow } from '@/lib/onboarding/first-opportunities';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { hasProductAccess } from '@/lib/billing/access-gate';
import { readFreeAuditView } from '@/lib/chat-first/free-audit-view';
import { loadPlan } from '@/lib/plan/load';
import { paywallCta, paywallCtaFromCheckout, type PaywallCta, type Plan } from '@/lib/plan/plan';
import { createAdminClient } from '@/lib/supabase/server';
import {
  TYPE_OPTIONS,
  isSetupKey,
  keysAnsweredByProfile,
  pendingKeys,
  type SetupKey,
} from './questions';
import { firstNameFrom, resolveSetupStage, type SetupStage } from './stage';

export type SetupAccount = {
  customerId: string;
  name: string;
  statusLabel: string;
  statusTone: 'active' | 'attention' | 'stopped';
  spend30: number | null;
  currency: string;
};

export type SetupFinding = {
  id: string;
  title: string;
  severity: string | null;
  impactLabel: string | null;
  impactAmount: number;
};

export type SetupState = {
  stage: SetupStage;
  edit: boolean;
  firstName: string | null;
  email: string | null;
  connect: {
    phase: ConnectPhase;
    stages: Array<{ id: string; label: string; state: 'done' | 'active' | 'pending' | 'failed' }>;
    error: string | null;
  } | null;
  revokedCount: number;
  accounts: SetupAccount[];
  selected: SetupAccount | null;
  /** What «نسمي نشاطك …؟» proposes: a real business name, else the Google Ads account name. */
  namePrefill: string | null;
  business: {
    name: string | null;
    sector: string | null;
    website: string | null;
    monthlyBudget: number | null;
    targetRegions: string[];
  } | null;
  /** Answers already on record, with the choice id when there is one (edit mode marks it). */
  answered: Partial<Record<SetupKey, string | null>>;
  pending: SetupKey[];
  consentAnswered: boolean;
  audit: {
    healthScore: number | null;
    findingsCount: number;
    estimatedMonthlyWaste: number | null;
    ranAt: string;
  } | null;
  findings: SetupFinding[];
  findingsTotal: number;
  subscriptionActive: boolean;
  trialEligible: boolean;
  /** Where the paywall button goes: the trial checkout, or /billing for a subscription that is stopped. */
  cta: PaywallCta;
  freeAudit: 'unknown' | 'exhausted' | 'in_progress' | 'available';
  /**
   * «خطتك جاهزة»: the audit's summary, the first decision open and the rest
   * locked. Read only for someone without access; null once they have it.
   */
  plan: Plan | null;
};

type User = { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null };

/**
 * Everything the setup screen needs, read through the caller's own RLS client
 * except the two service-owned tables (the connect job row and the onboarding
 * memory ledger), which are filtered by the authenticated user's own ids.
 */
export async function loadSetupState(supabase: any, user: User, opts: { edit?: boolean } = {}): Promise<SetupState> {
  const edit = Boolean(opts.edit);
  const { business, accounts, revokedAccounts, selectedAccount } = await getAccountWorkspace(user.id);

  let admin: any = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  const [job, ledger, access] = await Promise.all([
    readConnectJob(admin, user.id),
    business ? readLedger(admin, business.id) : Promise.resolve(new Map<SetupKey, string | null>()),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);

  const spend = job?.details?.spend ?? {};
  const ranked = sortAccountsBySpend(
    accounts.map((account) => ({
      customer_id: account.customer_id,
      customer_name: account.customer_name,
      google_status: account.google_status ?? null,
      currency_code: account.currency_code ?? null,
    })),
    spend
  ).map<SetupAccount>((account) => {
    const status = accountStatusView(account.google_status);
    return {
      customerId: normalizeCustomerId(account.customer_id),
      name: googleAdsAccountDisplayName(account),
      statusLabel: status.label,
      statusTone: status.tone,
      spend30: account.spend,
      currency: (account.currency_code ?? 'SAR').toUpperCase(),
    };
  });

  const selectedId = selectedAccount ? normalizeCustomerId(selectedAccount.customer_id) : null;
  const selected = ranked.find((account) => account.customerId === selectedId) ?? null;
  const needsChoice = accounts.length > 1 && !business?.selected_google_ads_customer_id;

  const connectView = resolveConnectProgress((job as ConnectJobSnapshot | null) ?? null);
  const connectRunning = connectView.phase === 'running';

  let consentAnswered = false;
  let audit: SetupState['audit'] = null;
  let findings: SetupFinding[] = [];
  let findingsTotal = 0;
  if (selectedAccount && !needsChoice) {
    const [consentRes, auditRes] = await Promise.all([
      supabase.from('autopilot_settings').select('consent').eq('account_id', selectedAccount.id).maybeSingle(),
      supabase
        .from('audits')
        .select('id, health_score, findings, estimated_monthly_waste, ran_at')
        .eq('account_id', selectedAccount.id)
        .order('ran_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    // A read error is "not answered": asking again is harmless, skipping is not.
    consentAnswered = Boolean(!consentRes?.error && consentRes?.data?.consent?.answer);
    const row = auditRes?.error ? null : auditRes?.data;
    if (row) {
      audit = {
        healthScore: row.health_score ?? null,
        findingsCount: Array.isArray(row.findings) ? row.findings.length : 0,
        estimatedMonthlyWaste: row.estimated_monthly_waste == null ? null : Number(row.estimated_monthly_waste),
        ranAt: row.ran_at,
      };
      const recs = await supabase
        .from('recommendations')
        .select('id, title, severity, expected_impact')
        .eq('audit_id', row.id)
        .eq('status', 'pending')
        .limit(50);
      const rows = (recs?.error ? [] : recs?.data ?? []) as OpportunityRow[];
      findingsTotal = rows.length;
      // Without access the amounts of the top decisions stay on the server
      // (this state goes whole to the browser): only titles are sent.
      findings = firstFindings(rows, hasProductAccess(access));
    }
  }

  const answered: Partial<Record<SetupKey, string | null>> = {};
  for (const key of keysAnsweredByProfile(business)) answered[key] = null;
  // The old form stored a free sector; when it matches a type label, edit mode can mark it.
  const typeFromSector = TYPE_OPTIONS.find((option) => option.label === business?.sector?.trim())?.id;
  if (typeFromSector) answered.type = typeFromSector;
  for (const [key, choice] of ledger) answered[key] = choice;

  const pending =
    selectedAccount && !needsChoice
      ? pendingKeys({ answered: Object.keys(answered) as SetupKey[], consentAnswered, edit })
      : [];

  const stage = resolveSetupStage({
    linkedAccounts: accounts.length,
    connectRunning,
    needsChoice,
    pending,
    auditExists: Boolean(audit),
    edit,
  });

  let trialEligible = false;
  let cta = paywallCta({ trialEligible: false });
  let freeAudit: SetupState['freeAudit'] = 'unknown';
  if (!access.active && accounts.length > 0) {
    const [checkout, view] = await Promise.all([
      getBillingCheckoutContext(supabase, user.id, user.email).catch(() => null),
      selectedId ? readFreeAuditView(selectedId, admin ?? undefined) : Promise.resolve('unknown' as const),
    ]);
    trialEligible = Boolean(checkout?.trialEligible);
    cta = paywallCtaFromCheckout(checkout);
    freeAudit = view ?? 'unknown';
  }

  let plan: Plan | null = null;
  if (!access.active && !edit && selectedAccount && !needsChoice) {
    try {
      plan = await loadPlan(supabase, { accountId: selectedAccount.id, currency: selectedAccount.currency_code });
    } catch {
      plan = null;
    }
  }

  const accountName =
    selectedAccount && !googleAdsAccountNameMissing(selectedAccount) ? selectedAccount.customer_name?.trim() || null : null;
  const namePrefill = (business?.sector ? business?.name : null) || accountName || business?.name || null;

  return {
    stage,
    edit,
    namePrefill,
    firstName: firstNameFrom(user.user_metadata ?? null),
    email: user.email ?? null,
    connect:
      job || connectView.phase !== 'none'
        ? {
            phase: connectView.phase,
            stages: connectView.stages.map((stage) => ({ id: stage.id, label: stage.label, state: stage.state })),
            error: connectView.error,
          }
        : null,
    revokedCount: revokedAccounts.length,
    accounts: needsChoice ? ranked : [],
    selected,
    business: business
      ? {
          name: business.name ?? null,
          sector: business.sector ?? null,
          website: business.website ?? null,
          monthlyBudget: business.monthly_budget ?? null,
          targetRegions: business.target_regions ?? [],
        }
      : null,
    answered,
    pending,
    consentAnswered,
    audit,
    findings,
    findingsTotal,
    subscriptionActive: access.active,
    trialEligible,
    cta,
    freeAudit,
    plan,
  };
}

async function readConnectJob(admin: any, userId: string): Promise<(ConnectJobSnapshot & { details: ConnectJobDetails | null }) | null> {
  if (!admin) return null;
  try {
    const { data, error } = await admin
      .from('job_runs')
      .select('status, started_at, finished_at, details')
      .eq('job_name', connectJobName(userId))
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Onboarding answers on record: the newest active fact per setup key. Any
 * failure (table not migrated, service key missing) reads as "nothing on
 * record", which only means a question may be asked again.
 */
export async function readLedger(admin: any, businessId: string): Promise<Map<SetupKey, string | null>> {
  const out = new Map<SetupKey, string | null>();
  if (!admin) return out;
  try {
    const { data, error } = await admin
      .from('business_memory')
      .select('data, created_at')
      .eq('business_id', businessId)
      .eq('source', 'onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(60);
    if (error || !Array.isArray(data)) return out;
    for (const row of data) {
      const key = row?.data?.setup_key;
      if (!isSetupKey(key) || out.has(key)) continue;
      const choice = typeof row.data.choice === 'string' ? row.data.choice : null;
      out.set(key, choice);
    }
    return out;
  } catch {
    return out;
  }
}

