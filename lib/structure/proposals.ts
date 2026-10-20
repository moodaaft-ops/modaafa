import { pickNum, pickStr } from '../growth/types';
import { validateStructurePayload } from './validate';
import { actionFingerprint, categoryForAction } from '../ai/action-fingerprint';
import { operationLabelAr } from '../ai/operation-labels';
import type { OptimizerAction } from '../ai/optimizer-agent';
export const structureProposalsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.STRUCTURE_PROPOSALS_ENABLED === 'true' && env.EXTENDED_ACTIONS_ENABLED === 'true';
export type StructureProposal = { operation: 'set_ai_max' | 'create_shared_budget' | 'create_portfolio_strategy' | 'add_placement_exclusions'; target_id: string; params: Record<string, unknown>; reason_ar: string };
/** Measured candidates only. Execution preflight is still authoritative at approval time. */
export function structureCandidates(rows: any[], placements: any[], healthy: boolean, customerId: string): StructureProposal[] {
  if (!healthy) return [];
  const out: StructureProposal[] = [];
  const campaigns = rows.filter((r) => pickStr(r, 'campaign.advertising_channel_type') === 'SEARCH' && pickStr(r, 'campaign.status') === 'ENABLED');
  for (const row of campaigns) {
    const strategy = pickStr(row, 'campaign.bidding_strategy_type');
    const aiMax = row.campaign?.aiMaxSetting?.enableAiMax ?? row.campaign?.ai_max_setting?.enable_ai_max;
    if (aiMax === false && ['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'].includes(strategy) && (pickNum(row, 'metrics.conversions') ?? 0) >= 30) {
      const resource = pickStr(row, 'campaign.resource_name');
      out.push({ operation: 'set_ai_max', target_id: resource, params: { campaign_resource: resource, enabled: true }, reason_ar: 'الحملة عندها تحويلات كافية ومزايدة ذكية، نقدر نجرّب AI Max بعد موافقتك' });
    }
  }
  const pool = campaigns.filter((r) => pickStr(r, 'campaign.bidding_strategy_type') === 'MAXIMIZE_CONVERSIONS' && (pickNum(r, 'metrics.conversions') ?? 0) >= 15).slice(0, 2);
  if (pool.length === 2) {
    const resources = pool.map((r) => pickStr(r, 'campaign.resource_name'));
    const budgets = pool.map((r) => pickStr(r, 'campaign_budget.resource_name'));
    const amount = pool.reduce((sum,r) => sum + (pickNum(r, 'campaign_budget.amount_micros') ?? 0), 0);
    if (pool.every((r) => pickStr(r, 'campaign.bidding_strategy')) && new Set(pool.map((r) => pickStr(r, 'campaign.bidding_strategy'))).size === 1 && new Set(budgets).size === 2 && pool.every((r) => (pickNum(r, 'campaign_budget.reference_count') ?? 0) === 1) && amount > 0) {
      out.push({ operation: 'create_shared_budget', target_id: resources[0], params: { name: 'ميزانية مشتركة من مُضاعف', amount_micros: amount, campaign_resources: resources }, reason_ar: 'نجمع ميزانية حملتين بدون زيادة إجمالي الميزانية اليومية، راجع مناسبة مشاركة الميزانية لهدف الحملتين' });
    }
    if (pool.every((r) => !pickStr(r, 'campaign.bidding_strategy'))) out.push({ operation: 'create_portfolio_strategy', target_id: resources[0], params: { name: 'مزايدة مشتركة من مُضاعف', strategy_type: 'MAXIMIZE_CONVERSIONS', campaign_resources: resources }, reason_ar: 'الحملتين تجمع تحويلات على نفس نوع المزايدة، تقدر تجمع تعلّمها باستراتيجية مشتركة بعد مراجعتك' });
  }
  const waste = placements.filter((r) => (pickNum(r, 'metrics.conversions') ?? 0) === 0 && (pickNum(r, 'metrics.clicks') ?? 0) >= 20 && (pickNum(r, 'metrics.cost_micros') ?? 0) >= 100e6)
    .map((r) => ({ kind: 'website', value: pickStr(r, 'detail_placement_view.placement') })).filter((p) => p.value).slice(0, 10);
  if (waste.length) out.push({ operation: 'add_placement_exclusions', target_id: `customers/${customerId}`, params: { level: 'account', placements: waste }, reason_ar: 'هالمواضع صرفت وجابت نقرات بدون تحويل خلال آخر شهر، راجعها قبل استبعادها' });
  return out.filter((p) => validateStructurePayload(p.operation, p.target_id, p.params, customerId).ok);
}
export async function readStructureProposals(customer: { query(sql: string): Promise<any[]> }, customerId: string, healthy: boolean) {
  if (!structureProposalsEnabled() || !healthy) return [];
  const rows = await customer.query(`SELECT campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type,
    campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.ai_max_setting.enable_ai_max,
    campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.reference_count,
    metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED' LIMIT 100`);
  const placements = await customer.query(`SELECT detail_placement_view.placement, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM detail_placement_view WHERE segments.date DURING LAST_30_DAYS AND metrics.conversions = 0 ORDER BY metrics.cost_micros DESC LIMIT 50`).catch(() => []);
  return structureCandidates(rows, placements, healthy, customerId);
}
export async function queueStructureProposals(db: any, accountId: string, proposals: StructureProposal[]) {
  let queued = 0;
  for (const p of proposals.slice(0, 4)) {
    const action = { type: p.operation, target_id: p.target_id, params: p.params } as OptimizerAction;
    const fingerprint = actionFingerprint(accountId, action);
    const { data, error } = await db.from('recommendations').select('id').eq('account_id', accountId).eq('fingerprint', fingerprint)
      .gte('created_at', new Date(Date.now()-14*86400000).toISOString()).limit(1);
    if (error) throw error;
    if (data?.length) continue;
    const { error: insertError } = await db.from('recommendations').insert({ account_id: accountId, fingerprint,
      category: categoryForAction(p.operation), severity: 'growth', title: operationLabelAr(p.operation), description: p.reason_ar,
      action_payload: { operation: p.operation, target_id: p.target_id, params: p.params, source: 'optimizer_cron' },
      expected_impact: { metric: 'performance', delta_pct: 0, delta_sar_per_month: 0 }, status: 'pending' });
    if (insertError && insertError.code !== '23505') throw insertError;
    if (!insertError) queued++;
  }
  return queued;
}
