import { actionFingerprint } from '@/lib/ai/action-fingerprint';
import { findBlockingAutopilotRecommendation } from '@/lib/autopilot/recommendation-dedupe';
import { operationLabelAr } from '@/lib/ai/operation-labels';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import {
  DATA_EXCLUSION_OPERATION,
  DATA_EXCLUSION_CHANNELS,
  dataExclusionName,
  validateDataExclusionParams,
} from './data-exclusion';
import {
  CREATE_LEAD_ACTION_OPERATION,
  SET_PRIMARY_OPERATION,
} from './conversion-actions';
import type { TrackingGap } from './tracking-gaps';

/**
 * Turns a measurement finding into a pending recommendation: the merchant sees
 * an approval card, and the existing execute path (guardrails, validateOnly,
 * claim, readback, rollback record) does the rest. Nothing here touches Google.
 */
type Db = any;

export type ProposalOutcome = { created: boolean; id: string | null; reason?: 'duplicate' | 'not_executable' | 'save_failed' };

async function createProposal(
  admin: Db,
  input: {
    accountId: string;
    customerId: string;
    operation: string;
    targetId: string;
    params: Record<string, unknown>;
    title: string;
    why: string;
    category: 'bidding' | 'structure';
    severity: 'critical' | 'medium' | 'growth';
    now: Date;
  }
): Promise<ProposalOutcome> {
  const shape = { title: input.title, description: input.why, expected_impact: null };
  const action = buildExecutableAction(
    { operation: input.operation, target_id: input.targetId, params: input.params },
    shape,
    input.customerId
  );
  if (!action) return { created: false, id: null, reason: 'not_executable' };

  const fingerprint = actionFingerprint(input.accountId, { type: action.type, target_id: action.target_id, params: action.params });
  const existing = await findBlockingAutopilotRecommendation(admin, input.accountId, fingerprint, input.now.getTime());
  if (existing) return { created: false, id: existing.id, reason: 'duplicate' };

  const { data, error } = await admin
    .from('recommendations')
    .insert({
      account_id: input.accountId,
      fingerprint,
      category: input.category,
      severity: input.severity,
      title: input.title,
      description: input.why,
      expected_impact: { metric: 'tracking_quality', delta_pct: 0, delta_sar_per_month: 0, basis: 'tracking_review' },
      action_payload: {
        operation: action.type,
        target_id: action.target_id,
        params: action.params,
        source: 'measurement',
      },
      status: 'pending',
    })
    .select('id')
    .maybeSingle();
  if (error || !data?.id) {
    if (error?.code === '23505') return { created: false, id: null, reason: 'duplicate' };
    return { created: false, id: null, reason: 'save_failed' };
  }
  return { created: true, id: data.id };
}

export function dataExclusionWhy(gap: TrackingGap) {
  return (
    `التتبع ما سجّل تحويلات من ${gap.start} إلى ${gap.end} (${gap.days} أيام) مع إن النقرات كانت شغالة، ` +
    `وكان المعدل قبلها حوالي ${gap.baselinePerDay} تحويل يومياً. ` +
    'نستبعد هالأيام من تعلم المزايدة الذكية عشان ما تتعلم من أرقام ناقصة. ما يتغير شي ثاني في الحملات وتقدر تتراجع بعد التنفيذ.'
  );
}

/** One card per resolved gap. Channel scope covers every enabled campaign of those types, which is how a tag outage behaves. */
export async function proposeDataExclusions(input: {
  admin: Db;
  accountId: string;
  customerId: string;
  gaps: TrackingGap[];
  channelTypes: string[];
  now?: Date;
}): Promise<ProposalOutcome[]> {
  const now = input.now ?? new Date();
  const channels = input.channelTypes.filter((type) => (DATA_EXCLUSION_CHANNELS as readonly string[]).includes(type));
  if (channels.length === 0) return [];
  const outcomes: ProposalOutcome[] = [];
  for (const gap of input.gaps) {
    const params = {
      name: dataExclusionName(gap.start, gap.end),
      scope: 'CHANNEL',
      advertising_channel_types: channels,
      start_date_time: `${gap.start} 00:00:00`,
      end_date_time: `${gap.end} 23:59:59`,
    };
    if (!validateDataExclusionParams(params).ok) {
      outcomes.push({ created: false, id: null, reason: 'not_executable' });
      continue;
    }
    outcomes.push(
      await createProposal(input.admin, {
        accountId: input.accountId,
        customerId: input.customerId,
        operation: DATA_EXCLUSION_OPERATION,
        targetId: `customers/${input.customerId.replace(/\D/g, '')}`,
        params,
        title: operationLabelAr(DATA_EXCLUSION_OPERATION) ?? 'استبعاد أيام التتبع المكسور',
        why: dataExclusionWhy(gap),
        category: 'bidding',
        severity: 'medium',
        now,
      })
    );
  }
  return outcomes;
}

export function proposeCreateLeadAction(input: {
  admin: Db;
  accountId: string;
  customerId: string;
  currencyCode: string;
  now?: Date;
}) {
  return createProposal(input.admin, {
    accountId: input.accountId,
    customerId: input.customerId,
    operation: CREATE_LEAD_ACTION_OPERATION,
    targetId: `customers/${input.customerId.replace(/\D/g, '')}`,
    params: { currency_code: input.currencyCode },
    title: operationLabelAr(CREATE_LEAD_ACTION_OPERATION) ?? 'إنشاء تحويل الزبون الفعلي',
    why:
      'عشان نرفع الزبائن اللي علّمتهم "صار زبون" لقوقل نحتاج تحويل من نوع رفع نقرات. ' +
      'ينشأ ثانوي، يعني ما يغيّر شي في المزايدة ولا في الصرف لين تجعله أساسي. بعد إنشائه تنتظر 6 ساعات قبل أول رفع.',
    category: 'structure',
    severity: 'growth',
    now: input.now ?? new Date(),
  });
}

export function proposePromoteLeadAction(input: {
  admin: Db;
  accountId: string;
  customerId: string;
  leadActionResource: string;
  demoteResources: string[];
  conversions30d: number;
  now?: Date;
}) {
  return createProposal(input.admin, {
    accountId: input.accountId,
    customerId: input.customerId,
    operation: SET_PRIMARY_OPERATION,
    targetId: input.leadActionResource,
    params: { conversion_action_resource: input.leadActionResource, demote_resources: input.demoteResources },
    title: operationLabelAr(SET_PRIMARY_OPERATION) ?? 'اجعل الزبون الفعلي تحويلاً أساسياً',
    why:
      `تحويل "زبون فعلي" سجّل ${Math.round(input.conversions30d)} في آخر 30 يوم، وهذا يكفي للمزايدة تتعلم منه. ` +
      (input.demoteResources.length > 0
        ? 'نحوّل نقرة الواتساب إلى ثانوية في نفس الخطوة عشان ما يتعدّان مع بعض. '
        : '') +
      'التعلم يبدأ من جديد جزئياً، فلا تغيّر الميزانية أو الهدف هالأسبوع. تقدر تتراجع بعد التنفيذ.',
    category: 'bidding',
    severity: 'medium',
    now: input.now ?? new Date(),
  });
}
