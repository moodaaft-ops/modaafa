import { buildExecutableAction } from '@/lib/ai/executable-action';
import { getBillingCheckoutContext } from '@/lib/billing/checkout-policy';
import { buildPlan, paywallCtaFromCheckout, type PaywallCta, type Plan, type PlanRecommendation } from './plan';

/** Pending and approved decisions, newest first: the same rows /home lists as «قرارات اليوم». */
export const PLAN_DECISION_LIMIT = 30;

/** Maps stored recommendation rows to plan input. `executable` comes from the payload, never from model text. */
export function toPlanRecommendations(rows: unknown): PlanRecommendation[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: any) => ({
    id: row.id,
    title: row.title ?? null,
    description: row.description ?? null,
    severity: row.severity ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    expected_impact: row.expected_impact ?? null,
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
  args: { accountId: string; currency?: string | null }
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
      .select('id, title, description, severity, status, expected_impact, action_payload, created_at')
      .eq('account_id', args.accountId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(PLAN_DECISION_LIMIT),
  ]);
  return buildPlan({
    audit: auditRes?.error ? null : auditRes?.data ?? null,
    recommendations: toPlanRecommendations(recsRes?.error ? [] : recsRes?.data ?? []),
    currency: args.currency,
  });
}

/** What a locked screen needs: the plan, and where its one button goes. */
export type PlanLockData = { plan: Plan; trialEligible: boolean; cta: PaywallCta };

/**
 * The plan lock for a screen other than /home (the audit, the approvals
 * screen): the same plan and the same CTA /home shows, so every place a person
 * without access can open says the same thing. A suspended account gets no
 * checkout read and no button (the caller shows the suspension line).
 */
export async function loadPlanLock(
  supabase: any,
  args: { accountId: string; currency?: string | null; userId: string; userEmail?: string | null; suspended?: boolean }
): Promise<PlanLockData> {
  const [plan, checkout] = await Promise.all([
    loadPlan(supabase, { accountId: args.accountId, currency: args.currency }),
    args.suspended
      ? Promise.resolve(null)
      : getBillingCheckoutContext(supabase, args.userId, args.userEmail).catch(() => null),
  ]);
  return { plan, trialEligible: Boolean(checkout?.trialEligible), cta: paywallCtaFromCheckout(checkout) };
}
