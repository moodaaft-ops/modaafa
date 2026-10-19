import { actionFingerprint } from '../ai/action-fingerprint';
import { GROWTH_LABELS_AR, type GrowthOperation } from './flags';

/** Pending approval cards for the growth operations. One pending card per identical action. */

const TITLES_AR: Record<GrowthOperation, string> = {
  launch_demand_gen: 'ابنِ حملة ديماند جن موقوفة',
  create_user_list: 'أنشئ قائمة جمهور',
  attach_audience: 'اربط الجمهور بالمجموعة',
  create_experiment: 'ابدأ التجربة',
  end_experiment: 'أوقف التجربة',
  promote_experiment: 'اعتمد نتيجة التجربة',
  create_image_assets: 'ارفع الصور',
};

export function growthCardRow(accountId: string, operation: GrowthOperation, params: Record<string, unknown>, description: string, category = 'structure') {
  const action = { type: operation, target_id: '', params };
  return {
    account_id: accountId,
    category,
    severity: 'growth',
    title: TITLES_AR[operation] ?? GROWTH_LABELS_AR[operation],
    description,
    expected_impact: { metric: 'growth', delta_pct: 0, delta_sar_per_month: 0 },
    action_payload: { operation, target_id: '', params },
    status: 'pending',
    fingerprint: actionFingerprint(accountId, action),
  };
}

export async function createGrowthCard(admin: any, row: ReturnType<typeof growthCardRow>) {
  const { data: existing } = await admin
    .from('recommendations')
    .select('id')
    .eq('account_id', row.account_id)
    .eq('fingerprint', row.fingerprint)
    .in('status', ['pending', 'approved', 'executing'])
    .limit(1);
  if (Array.isArray(existing) && existing.length > 0) return { id: String(existing[0].id), created: false };
  const { data, error } = await admin.from('recommendations').insert(row).select('id').maybeSingle();
  if (error || !data) throw new Error(`Unable to create the card: ${error?.message ?? 'no row'}`);
  return { id: String(data.id), created: true };
}
