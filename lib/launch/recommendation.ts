import { actionFingerprint } from '../ai/action-fingerprint';
import { LAUNCH_OPERATION } from './flag';
import type { LaunchExecution } from './execute';
import type { LaunchPlan } from './types';

/**
 * The two approval cards of a launch.
 *
 *   1. «ابنِ الحملة موقوفة»: operation launch_campaign. Builds everything PAUSED.
 *   2. «شغّلها»: the existing enable_campaign operation, created only after the
 *      build was applied, aimed at the campaign that was just created.
 *
 * They are separate cards on purpose: approving the build never spends.
 */

export const LAUNCH_CARD_TITLE_AR = 'ابنِ الحملة موقوفة';
export const ENABLE_CARD_TITLE_AR = 'شغّلها';

const sar = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} ريال`;

export function buildCardRow(accountId: string, plan: LaunchPlan) {
  const action = { type: LAUNCH_OPERATION, target_id: '', params: { plan } };
  const groups = plan.ad_groups.length;
  return {
    account_id: accountId,
    category: 'structure',
    severity: 'growth',
    title: LAUNCH_CARD_TITLE_AR,
    description: `حملة «${plan.name}» تنبني موقوفة بميزانية ${sar(plan.budget.daily_sar)} يومياً و${groups} ${groups === 1 ? 'مجموعة' : 'مجموعات'}. ما يصرف شي لين توافق على تشغيلها.`,
    expected_impact: { metric: 'launch', delta_pct: 0, delta_sar_per_month: 0 },
    action_payload: { operation: LAUNCH_OPERATION, target_id: '', params: { plan } },
    status: 'pending',
    fingerprint: actionFingerprint(accountId, action),
  };
}

export function enableCardRow(accountId: string, execution: Pick<LaunchExecution, 'campaign_resource' | 'campaign_name'>, plan?: { budget?: { daily_sar?: number } }) {
  const action = { type: 'enable_campaign', target_id: execution.campaign_resource, params: {} };
  const daily = plan?.budget?.daily_sar;
  return {
    account_id: accountId,
    category: 'structure',
    severity: 'growth',
    title: ENABLE_CARD_TITLE_AR,
    description: `تشغيل حملة «${execution.campaign_name}»${daily ? ` وتبدأ تصرف لين ${sar(daily)} باليوم` : ''}. تقدر توقفها بأي وقت.`,
    expected_impact: { metric: 'launch', delta_pct: 0, delta_sar_per_month: 0 },
    action_payload: { operation: 'enable_campaign', target_id: execution.campaign_resource, params: {} },
    status: 'pending',
    fingerprint: actionFingerprint(accountId, action),
  };
}

/**
 * Called after the build card is applied. Never throws: the build already
 * happened, and a missing second card only costs the merchant one more tap.
 */
export async function createEnableCard(
  admin: any,
  recommendation: { account_id: string; action_payload?: any },
  result: any
): Promise<boolean> {
  try {
    const campaign = result?.campaign_resource;
    if (typeof campaign !== 'string' || !/^customers\/\d+\/campaigns\/\d+$/.test(campaign)) return false;
    // A build that did not read back clean is shown to the merchant, not auto-offered for enabling.
    if (result?.readback && result.readback.ok === false) return false;
    const row = enableCardRow(
      recommendation.account_id,
      { campaign_resource: campaign, campaign_name: String(result?.campaign_name ?? '') },
      recommendation.action_payload?.params?.plan
    );
    const { data: existing } = await admin
      .from('recommendations')
      .select('id')
      .eq('account_id', row.account_id)
      .eq('fingerprint', row.fingerprint)
      .in('status', ['pending', 'approved', 'executing'])
      .limit(1);
    if (Array.isArray(existing) && existing.length > 0) return true;
    const { error } = await admin.from('recommendations').insert(row);
    return !error;
  } catch (error) {
    console.error('Launch enable card could not be created', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** One pending launch card per identical plan. */
export async function createBuildCard(admin: any, accountId: string, plan: LaunchPlan) {
  const row = buildCardRow(accountId, plan);
  const { data: existing } = await admin
    .from('recommendations')
    .select('id')
    .eq('account_id', accountId)
    .eq('fingerprint', row.fingerprint)
    .in('status', ['pending', 'approved', 'executing'])
    .limit(1);
  if (Array.isArray(existing) && existing.length > 0) return { id: String(existing[0].id), created: false };
  const { data, error } = await admin.from('recommendations').insert(row).select('id').maybeSingle();
  if (error || !data) throw new Error(`Unable to create the launch card: ${error?.message ?? 'no row'}`);
  return { id: String(data.id), created: true };
}
