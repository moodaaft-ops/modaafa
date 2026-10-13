import { buildExecutableAction } from '@/lib/ai/executable-action';
import { buildPlan, type Plan, type PlanRecommendation } from './plan';

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
