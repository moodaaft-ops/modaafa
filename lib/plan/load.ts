import { getUserBusinessWithClient } from '@/lib/accounts/selection';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';
import { adaptiveLockedPlan } from '@/lib/setup/adaptive/locked-plan';
import type { ScenarioDecision } from '@/lib/setup/adaptive/types';
import { dropStalePending } from '@/lib/recommendations/staleness';
import { createAdminClient } from '@/lib/supabase/server';
import { buildPlan, paywallCtaFromCheckout, type PaywallCta, type Plan, type PlanRecommendation } from './plan';

/** Pending and approved decisions, newest first: the same rows /home lists as «قرارات اليوم». */
export const PLAN_DECISION_LIMIT = 30;

/**
 * A decision is still waiting for the person while it is `pending` (not decided) or
 * `approved` (decided, "وافقت عليه، باقي التنفيذ": the last press is theirs). /home,
 * the plan and the lifecycle emails' open-decision count all read this one list.
 */
export const OPEN_DECISION_STATUSES: readonly string[] = ['pending', 'approved'];

/** Maps stored recommendation rows to plan input. `executable` comes from the payload, never from model text. */
export function toPlanRecommendations(rows: unknown): PlanRecommendation[] {
  if (!Array.isArray(rows)) return [];
  // A pending optimizer card older than 14 days is not a current decision (lib/recommendations/staleness.ts).
  return dropStalePending(rows).map((row: any) => ({
    id: row.id,
    title: row.title ?? null,
    description: row.description ?? null,
    severity: row.severity ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    expected_impact: row.expected_impact ?? null,
    category: typeof row.category === 'string' ? row.category : null,
    executable: Boolean(row.action_payload && buildExecutableAction(row.action_payload, row)),
  }));
}

/**
 * The plan for one ad account, read through the caller's own RLS client. Two
 * small reads (the newest audit and its open decisions); any read error is
 * "nothing there", which the plan renders honestly instead of failing.
 */
export async function loadPlan(
  supabase: any,
  args: {
    accountId: string;
    currency?: string | null;
    /** Keep each decision's audit category on the plan (the adaptive onboarding rules read it on the server and strip it before the browser). */
    includeCategory?: boolean;
  }
): Promise<Plan> {
  const [auditRes, recsRes] = await Promise.all([
    supabase
      .from('audits')
      .select('health_score, estimated_monthly_waste, ran_at')
      .eq('account_id', args.accountId)
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('recommendations')
      .select('id, title, description, severity, status, category, expected_impact, action_payload, created_at')
      .eq('account_id', args.accountId)
      .in('status', [...OPEN_DECISION_STATUSES])
      .order('created_at', { ascending: false })
      .limit(PLAN_DECISION_LIMIT),
  ]);
  return buildPlan({
    audit: auditRes?.error ? null : auditRes?.data ?? null,
    recommendations: toPlanRecommendations(recsRes?.error ? [] : recsRes?.data ?? []),
    currency: args.currency,
    includeCategory: args.includeCategory === true,
  });
}

/**
 * What a locked screen needs: the plan, and where its one button goes. With
 * the adaptive onboarding on, the plan is the one the setup screen showed: a
 * rules decision may lead (`lead`) and the audit's own first decision may carry
 * a «ليش أول شي» line (`firstWhy`). Both are absent otherwise.
 */
export type PlanLockData = {
  plan: Plan;
  trialEligible: boolean;
  cta: PaywallCta;
  lead?: ScenarioDecision | null;
  firstWhy?: string | null;
};

/** For tests: what `loadPlanLock` otherwise takes from the environment. */
export type PlanLockDeps = {
  env?: Record<string, string | undefined>;
  /** The service client the stored read and the ledger are read with; created on demand when absent. */
  admin?: any | null;
  now?: Date;
};

/**
 * The plan lock for a screen other than /home (the audit, the approvals
 * screen): the same plan and the same CTA /home shows, so every place a person
 * without access can open says the same thing. A suspended account gets no
 * checkout read and no button (the caller shows the suspension line).
 *
 * For someone the adaptive onboarding is on for, the plan is also corrected by
 * what the onboarding found (the newest stored read of the account, up to 30
 * days old, and the customer's answers), so this screen never contradicts the
 * plan they were just shown: no second open decision beside the rules one, and
 * no waste number for an account that cannot say what its ads bring.
 */
export async function loadPlanLock(
  supabase: any,
  args: { accountId: string; currency?: string | null; userId: string; userEmail?: string | null; suspended?: boolean },
  deps: PlanLockDeps = {}
): Promise<PlanLockData> {
  const adaptiveOn = isAdaptiveOnboarding(deps.env ?? process.env, args.userEmail);
  const [plan, checkout] = await Promise.all([
    loadPlan(supabase, { accountId: args.accountId, currency: args.currency, includeCategory: adaptiveOn }),
    args.suspended
      ? Promise.resolve(null)
      : getBillingCheckoutContext(supabase, args.userId, args.userEmail).catch(() => null),
  ]);
  const base = { trialEligible: Boolean(checkout?.trialEligible), cta: paywallCtaFromCheckout(checkout) };
  if (!adaptiveOn) return { plan, ...base };

  let admin: any = null;
  if (deps.admin !== undefined) {
    admin = deps.admin;
  } else {
    try {
      admin = createAdminClient();
    } catch {
      admin = null;
    }
  }
  const business = await getUserBusinessWithClient(supabase, args.userId).catch(() => null);
  const locked = await adaptiveLockedPlan({
    admin,
    accountId: args.accountId,
    business,
    plan,
    currency: args.currency,
    now: deps.now,
  });
  return { plan: locked.plan, ...base, lead: locked.lead, firstWhy: locked.firstWhy };
}
