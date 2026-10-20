import type Anthropic from '@anthropic-ai/sdk';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import { BUDGET_STEP_MAX_PCT, BUDGET_STEP_MIN_PCT } from '@/lib/ai/optimizer-gates';
import { checkGuardrails, sanitizePromptText, type OptimizerAction } from '@/lib/ai/optimizer-agent';
import { actionFingerprint, categoryForAction, severityForAction } from '@/lib/ai/action-fingerprint';
import { operationLabelAr } from '@/lib/ai/operation-labels';
import { findBlockingAutopilotRecommendation } from '@/lib/autopilot/recommendation-dedupe';
import type { ChatCard } from '@/lib/chat-first/contracts';
import type { EvidenceRegistry } from './evidence';
import type { EvidenceRow } from './tools/types';
import { isExtendedActionsEnabled } from '@/lib/ai/extended-actions/flag';
import { isExtendedOperation } from '@/lib/ai/extended-actions/types';
import { lockFamilyMembers } from '@/lib/ai/extended-actions/guardrails';
import {
  EXTENDED_CHOICES_SCHEMA,
  EXTENDED_PREPARE_OPERATIONS,
  EXTENDED_TOOL_NOTE,
  isExtendedPrepareOperation,
  resolveExtended,
} from './prepare-change-extended';
import {
  ADS_STUDIO_CHOICES_SCHEMA,
  ADS_STUDIO_PREPARE_OPERATIONS,
  ADS_STUDIO_TOOL_NOTE,
  isAdsStudioPrepareOperation,
  resolveAdsStudio,
} from './prepare-change-ads';
import { isAdsStudioActive } from '@/lib/ads/flag';
import { addFingerprint, replaceFingerprint } from '@/lib/ads/proposals';

/**
 * prepare_change (spec 83, section 4.4).
 *
 * The model picks an operation, evidence refs and non-numeric choices. The
 * server does everything else: it resolves refs to the rows the read tools
 * returned THIS turn, builds resource names and amounts from those rows, runs
 * the existing executable-action boundary and guardrails, dedupes on the same
 * fingerprint as the optimizer, and writes ONE pending recommendation. Nothing
 * here touches Google Ads; execution stays behind the approval button.
 */

export const PREPARE_OPERATIONS = [
  'add_negative_keywords',
  'pause_keyword',
  'add_keyword',
  'adjust_budget',
  'pause_ad',
  'pause_campaign',
  'enable_campaign',
  'manual_steps',
] as const;
export type PrepareOperation = (typeof PREPARE_OPERATIONS)[number];

/** Per turn, and per account across all open chat proposals. */
export const MAX_PROPOSALS_PER_TURN = 3;
export const MAX_OPEN_CHAT_PROPOSALS = 10;
const SAME_TARGET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REPROPOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const BASE_PREPARE_CHANGE_TOOL = {
  name: 'prepare_change',
  description:
    'Prepare ONE change for the customer to approve. It never changes the account: it creates a pending proposal card ' +
    'with an approve button. Point at evidence refs returned by the read tools in THIS turn; the server builds every ' +
    'resource name and number from those rows. add_negative_keywords: 1 to 10 refs of wasted search terms (st_) or ' +
    'negative word candidates (nw_), all in the same campaign. pause_keyword: one kw_ ref. add_keyword: one winning st_ ' +
    'ref. adjust_budget: one cmp_ ref plus choices.delta_pct (5 to 20 up, or -5 to -20 down). pause_ad: one ad_ ref. ' +
    'pause_campaign / enable_campaign: one cmp_ ref. manual_steps: no refs, steps_ar only, for things the customer ' +
    'does by hand (locations, schedule, languages, tracking, new campaigns). Max 3 per turn.',
  input_schema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...PREPARE_OPERATIONS] },
      evidence_refs: {
        type: 'array',
        items: { type: 'string', pattern: '^[a-z]{1,6}_[0-9]{1,4}$' },
        maxItems: 10,
      },
      choices: {
        type: 'object',
        properties: {
          match_type: { type: 'string', enum: ['EXACT', 'PHRASE'] },
          delta_pct: { type: 'number', minimum: -BUDGET_STEP_MAX_PCT, maximum: BUDGET_STEP_MAX_PCT },
          campaign_ref: { type: 'string', pattern: '^cmp_[0-9]{1,4}$' },
        },
        additionalProperties: false,
      },
      headline_ar: { type: 'string', maxLength: 90, description: 'Short Arabic title. Used only for manual_steps.' },
      why_ar: {
        type: 'string',
        maxLength: 400,
        description: 'One or two lines in plain Saudi Arabic: why this helps the business. No numbers you did not read.',
      },
      steps_ar: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 8 },
    },
    required: ['operation', 'why_ar'],
    additionalProperties: false,
  },
} satisfies Anthropic.Tool;

export const PREPARE_CHANGE_TOOL: Anthropic.Tool = BASE_PREPARE_CHANGE_TOOL;

/**
 * The tool the brain offers. Flag off returns the base tool object itself, so
 * the schema is unchanged; flag on adds the extended operations and choices.
 */
export function prepareChangeToolFor(extended: boolean, adsStudio = false): Anthropic.Tool {
  if (!extended) return PREPARE_CHANGE_TOOL;
  const base = BASE_PREPARE_CHANGE_TOOL;
  const studio = adsStudio ? [...ADS_STUDIO_PREPARE_OPERATIONS] : [];
  return {
    ...base,
    description: base.description + EXTENDED_TOOL_NOTE + (adsStudio ? ADS_STUDIO_TOOL_NOTE : ''),
    input_schema: {
      ...base.input_schema,
      properties: {
        ...base.input_schema.properties,
        operation: { type: 'string', enum: [...PREPARE_OPERATIONS, ...EXTENDED_PREPARE_OPERATIONS, ...studio] },
        choices: {
          ...base.input_schema.properties.choices,
          properties: {
            ...base.input_schema.properties.choices.properties,
            ...EXTENDED_CHOICES_SCHEMA,
            ...(adsStudio ? ADS_STUDIO_CHOICES_SCHEMA : {}),
          },
        },
      },
    },
  } as Anthropic.Tool;
}

export type PrepareContext = {
  registry: EvidenceRegistry;
  accountId: string;
  customerId: string;
  currencyCode: string;
  sessionId: string | null;
  subscriptionActive: boolean;
  admin: any;
  proposalsThisTurn: number;
  now: Date;
  /** 'read_only' (validate-only probe): only manual steps can be prepared. */
  writeAccess?: 'full' | 'read_only' | 'unknown';
  deps?: {
    checkGuardrails?: typeof checkGuardrails;
    findBlocking?: typeof findBlockingAutopilotRecommendation;
  };
};

export type PrepareOutcome =
  | { ok: true; card: ChatCard; recommendationId: string | null; created: boolean; modelText: string }
  | { ok: false; code: string; modelText: string };

type Resolved = {
  payload: { operation: OptimizerAction['type']; target_id: string; params: Record<string, unknown> };
  targetLabel: string;
  changes: string[];
  warnings: string[];
  evidence: Array<{ label: string; value: string }>;
  /** Spend the change is expected to stop or move, in account currency, over the read period. */
  monthlyAmount: number;
  size: 'small' | 'large';
  sameTargetKey: string | null;
};

class PrepareError extends Error {
  constructor(
    readonly code: string,
    readonly messageAr: string
  ) {
    super(code);
  }
}

const fail = (code: string, messageAr: string): never => {
  throw new PrepareError(code, messageAr);
};

function text(value: unknown, max = 200) {
  return typeof value === 'string' ? sanitizePromptText(value, max).trim() : '';
}

function numberOf(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value: number, currency: string) {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
}

function resolveRefs(ctx: PrepareContext, refs: unknown): EvidenceRow[] {
  const list = Array.isArray(refs) ? refs : [];
  const rows: EvidenceRow[] = [];
  const seen = new Set<string>();
  for (const ref of list.slice(0, 10)) {
    const row = ctx.registry.get(ref);
    if (!row) fail('unknown_ref', `المرجع ${text(ref, 16) || '؟'} مو من نتائج هذا الدور. اقرأ البيانات بأداة القراءة أول.`);
    if (seen.has(row!.ref)) continue;
    seen.add(row!.ref);
    rows.push(row!);
  }
  return rows;
}

function one(rows: EvidenceRow[], kind: EvidenceRow['kind']) {
  if (rows.length !== 1 || rows[0].kind !== kind) {
    fail('wrong_refs', `هذي العملية تحتاج مرجع واحد من نوع ${kind}.`);
  }
  return rows[0];
}

function resolveNegatives(ctx: PrepareContext, rows: EvidenceRow[], choices: Record<string, unknown>): Resolved {
  if (rows.length === 0) fail('wrong_refs', 'حدد العبارات الضايعة بمراجعها (st_ أو nw_).');
  const pinnedCampaign = choices.campaign_ref ? ctx.registry.get(choices.campaign_ref) : undefined;
  if (choices.campaign_ref && (!pinnedCampaign || pinnedCampaign.kind !== 'campaign')) {
    fail('unknown_ref', 'campaign_ref لازم يكون مرجع حملة من get_campaigns في هذا الدور.');
  }
  const pinnedResource = pinnedCampaign ? String(pinnedCampaign.data.resource_name ?? '') : '';

  const items: Array<{ text: string; campaign: string; campaignName: string; cost: number; clicks: number; fromWord: boolean }> = [];
  for (const row of rows) {
    if (row.kind === 'search_term') {
      if (row.data.role !== 'waste' || numberOf(row.data.conversions) > 0) {
        fail('not_waste', `العبارة ${row.ref} جابت تحويل أو مو من العبارات الضايعة، ما تنمنع.`);
      }
      items.push({
        // The exact query Google saw; the sanitized `term` is only for the model.
        text: String(row.data.term_raw ?? row.data.term ?? ''),
        campaign: String(row.data.campaign_resource_name ?? ''),
        campaignName: String(row.data.campaign_name ?? ''),
        cost: numberOf(row.data.cost),
        clicks: numberOf(row.data.clicks),
        fromWord: false,
      });
    } else if (row.kind === 'negative_word') {
      const campaigns = Array.isArray(row.data.campaigns) ? (row.data.campaigns as Array<Record<string, unknown>>) : [];
      let chosen = pinnedResource
        ? campaigns.find((c) => c.campaign_resource_name === pinnedResource)
        : campaigns.length === 1
          ? campaigns[0]
          : undefined;
      if (!chosen && !pinnedResource && items.length > 0) {
        chosen = campaigns.find((c) => c.campaign_resource_name === items[0].campaign);
      }
      if (!chosen) {
        fail(
          'ambiguous_campaign',
          `الكلمة ${row.ref} طالعة في أكثر من حملة أو مو في الحملة المحددة. حدد الحملة بـ choices.campaign_ref.`
        );
      }
      items.push({
        text: String(row.data.word ?? ''),
        campaign: String(chosen!.campaign_resource_name ?? ''),
        campaignName: String(chosen!.campaign_name ?? ''),
        cost: numberOf(chosen!.cost),
        clicks: 0,
        fromWord: true,
      });
    } else {
      fail('wrong_refs', `المرجع ${row.ref} مو عبارة بحث ولا كلمة سلبية مرشحة.`);
    }
  }

  const campaign = items[0].campaign;
  if (!campaign || items.some((item) => item.campaign !== campaign)) {
    fail('mixed_campaigns', 'كل العبارات لازم تكون في نفس الحملة. جهّز اقتراح لكل حملة لحاله.');
  }
  if (pinnedResource && pinnedResource !== campaign) {
    fail('mixed_campaigns', 'العبارات مو في الحملة المحددة بـ campaign_ref.');
  }

  const anyWord = items.some((item) => item.fromWord);
  const requested = String(choices.match_type ?? '');
  const matchType = requested === 'EXACT' || requested === 'PHRASE' ? requested : anyWord ? 'PHRASE' : 'EXACT';
  const texts = items.map((item) => item.text);
  const campaignName = items[0].campaignName;
  const cost = items.reduce((sum, item) => sum + item.cost, 0);
  const periodDays = Math.max(1, numberOf(rows[0].data.period_days) || 30);
  const matchLabel = matchType === 'EXACT' ? 'مطابقة تامة' : 'مطابقة عبارة';

  const single = texts.length === 1;
  // Always a batch, even for one term: the batch preflight drops any negative
  // that would block a converting term or an enabled keyword, and validates
  // length. The single add_negative_keyword path has neither check.
  const payload = {
    operation: 'add_negative_keywords_batch' as const,
    target_id: campaign,
    params: { campaign_resource: campaign, match_type: matchType, keywords: texts },
  };

  const warnings: string[] = [];
  if (matchType === 'PHRASE') {
    warnings.push('مطابقة العبارة تمنع أي بحث فيه هذي الكلمات، مو بس العبارة نفسها.');
  }
  return {
    payload,
    targetLabel: campaignName,
    changes: texts.map((t) => `منع «${t}» (${matchLabel}) في حملة «${campaignName}»`),
    warnings,
    evidence: items.map((item) => ({
      label: item.text,
      value: item.fromWord
        ? `${money(item.cost, ctx.currencyCode)} صرف بدون تحويل في عبارات فيها الكلمة`
        : `${money(item.cost, ctx.currencyCode)} على ${item.clicks} نقرة بدون تحويل`,
    })),
    // Spend over the read window, scaled to 30 days.
    monthlyAmount: (cost * 30) / periodDays,
    // V1 "small" is exactly what autopilot may run: one EXACT negative for one wasted term.
    size: single && matchType === 'EXACT' && !anyWord ? 'small' : 'large',
    sameTargetKey: null,
  };
}

function resolve(ctx: PrepareContext, operation: PrepareOperation | string, rows: EvidenceRow[], choices: Record<string, unknown>): Resolved {
  const currency = ctx.currencyCode;
  if (isAdsStudioPrepareOperation(operation)) {
    if (!isAdsStudioActive()) fail('unknown_operation', 'العملية غير معروفة.');
    return resolveAdsStudio(operation, rows, choices, { fail, numberOf, text, customerId: ctx.customerId }) as Resolved;
  }
  if (isExtendedPrepareOperation(operation)) {
    if (!isExtendedActionsEnabled()) fail('unknown_operation', 'العملية غير معروفة.');
    return resolveExtended(operation, rows, choices, { fail, numberOf, text }) as Resolved;
  }
  switch (operation) {
    case 'add_negative_keywords':
      return resolveNegatives(ctx, rows, choices);

    case 'pause_keyword': {
      const row = one(rows, 'keyword');
      if (row.data.status !== 'ENABLED') fail('not_enabled', 'الكلمة مو مفعّلة أصلاً.');
      const cost = numberOf(row.data.cost);
      return {
        payload: { operation: 'pause_keyword', target_id: String(row.data.criterion_resource_name ?? ''), params: {} },
        targetLabel: String(row.data.text ?? ''),
        changes: [`إيقاف الكلمة «${row.data.text}» في حملة «${row.data.campaign_name}»`],
        warnings: numberOf(row.data.conversions) > 0 ? ['هذي الكلمة جابت تحويلات في الفترة، تأكد قبل الإيقاف.'] : [],
        evidence: [
          {
            label: String(row.data.text ?? ''),
            value: `${money(cost, currency)} على ${numberOf(row.data.clicks)} نقرة، ${numberOf(row.data.conversions)} تحويل`,
          },
        ],
        monthlyAmount: numberOf(row.data.conversions) > 0 ? 0 : cost,
        size: 'large',
        sameTargetKey: null,
      };
    }

    case 'add_keyword': {
      const row = one(rows, 'search_term');
      if (row.data.role !== 'winner' || numberOf(row.data.conversions) <= 0) {
        fail('not_winner', 'تُضاف كلمة بس من عبارة جابت تحويلات.');
      }
      const requested = String(choices.match_type ?? '');
      const matchType = requested === 'PHRASE' ? 'PHRASE' : 'EXACT';
      return {
        payload: {
          operation: 'add_keyword',
          target_id: String(row.data.ad_group_resource_name ?? ''),
          params: {
            ad_group_resource: String(row.data.ad_group_resource_name ?? ''),
            keyword_text: String(row.data.term_raw ?? row.data.term ?? ''),
            match_type: matchType,
            source: {
              clicks: numberOf(row.data.clicks),
              conversions: numberOf(row.data.conversions),
              cost: numberOf(row.data.cost),
            },
          },
        },
        targetLabel: String(row.data.term ?? ''),
        changes: [
          `إضافة «${row.data.term}» ككلمة (${matchType === 'EXACT' ? 'مطابقة تامة' : 'مطابقة عبارة'}) في مجموعة «${row.data.ad_group_name}»`,
        ],
        warnings: ['إضافة كلمة ممكن تزيد الصرف.'],
        evidence: [
          {
            label: String(row.data.term ?? ''),
            value: `${numberOf(row.data.conversions)} تحويل من ${money(numberOf(row.data.cost), currency)}`,
          },
        ],
        monthlyAmount: 0,
        size: 'large',
        sameTargetKey: null,
      };
    }

    case 'pause_ad': {
      const row = one(rows, 'ad');
      if (row.data.status !== undefined && row.data.status !== 'ENABLED') fail('not_enabled', 'الإعلان مو شغال أصلاً.');
      return {
        payload: { operation: 'pause_ad', target_id: String(row.data.ad_group_ad_resource_name ?? ''), params: {} },
        targetLabel: String(row.data.ad_group_name ?? ''),
        changes: [`إيقاف إعلان في مجموعة «${row.data.ad_group_name}» بحملة «${row.data.campaign_name}»`],
        warnings: [],
        evidence: [
          {
            label: `قوة الإعلان ${row.data.ad_strength ?? 'غير معروفة'}`,
            value: `${numberOf(row.data.clicks)} نقرة، ${numberOf(row.data.conversions)} تحويل، ${money(numberOf(row.data.cost), currency)}`,
          },
        ],
        monthlyAmount: 0,
        size: 'large',
        sameTargetKey: null,
      };
    }

    case 'pause_campaign':
    case 'enable_campaign': {
      const row = one(rows, 'campaign');
      const wanted = operation === 'pause_campaign' ? 'ENABLED' : 'PAUSED';
      if (row.data.status !== wanted) {
        fail('wrong_status', operation === 'pause_campaign' ? 'الحملة مو شغالة أصلاً.' : 'الحملة مو موقفة.');
      }
      const name = String(row.data.name ?? '');
      return {
        payload: { operation, target_id: String(row.data.resource_name ?? ''), params: {} },
        targetLabel: name,
        changes: [operation === 'pause_campaign' ? `إيقاف حملة «${name}» كاملة` : `تشغيل حملة «${name}»`],
        warnings:
          operation === 'pause_campaign'
            ? ['إيقاف الحملة يوقف كل إعلاناتها لين ترجع تشغلها.']
            : ['تشغيل الحملة يرجّع الصرف عليها بميزانيتها اليومية.'],
        evidence: [{ label: name, value: `الحالة الحالية ${row.data.status}` }],
        monthlyAmount: 0,
        size: 'large',
        sameTargetKey: String(row.data.resource_name ?? ''),
      };
    }

    case 'adjust_budget': {
      const row = one(rows, 'campaign');
      const delta = Math.round(numberOf(choices.delta_pct) * 10) / 10;
      if (!delta || Math.abs(delta) < BUDGET_STEP_MIN_PCT || Math.abs(delta) > BUDGET_STEP_MAX_PCT) {
        fail('bad_delta', 'نسبة تعديل الميزانية لازم تكون من 5 إلى 20 بالزيادة أو بالنقصان.');
      }
      const budgetResource = String(row.data.budget_resource_name ?? '');
      const current = numberOf(row.data.budget_micros);
      if (!budgetResource || current <= 0) fail('no_budget', 'ما لقيت ميزانية الحملة في البيانات.');
      // Google wants budget amounts in whole cents (multiples of 10,000 micros).
      const next = Math.round((current * (1 + delta / 100)) / 10_000) * 10_000;
      const name = String(row.data.name ?? '');
      const perDay = (micros: number) => money(micros / 1_000_000, currency);
      return {
        payload: {
          operation: 'adjust_budget',
          target_id: budgetResource,
          params: {
            budget_resource: budgetResource,
            current_amount_micros: current,
            new_amount_micros: next,
            delta_pct: delta,
          },
        },
        targetLabel: name,
        changes: [`ميزانية حملة «${name}» اليومية من ${perDay(current)} إلى ${perDay(next)}`],
        warnings: delta > 0 ? ['رفع الميزانية يزيد الصرف.'] : [],
        evidence: [{ label: name, value: `الميزانية اليومية الحالية ${perDay(current)}` }],
        monthlyAmount: 0,
        size: 'large',
        sameTargetKey: budgetResource,
      };
    }

    default:
      return fail('unsupported_operation', 'هذي العملية ما تتجهز من المحادثة. اكتبها كخطوات يدوية (manual_steps).');
  }
}

/** True when the same kind of change hit the same target in the last 7 days (titan red rule 6). */
async function changedRecently(ctx: PrepareContext, resolved: Resolved): Promise<boolean> {
  if (!resolved.sameTargetKey) return false;
  const since = new Date(ctx.now.getTime() - SAME_TARGET_WINDOW_MS).toISOString();
  const { data, error } = await ctx.admin
    .from('ai_actions')
    .select('action_type, payload')
    .eq('account_id', ctx.accountId)
    .in('action_type', [
      'adjust_budget',
      'pause_campaign',
      'enable_campaign',
      ...(isExtendedActionsEnabled() && isExtendedOperation(resolved.payload.operation)
        ? lockFamilyMembers(resolved.payload.operation)
        : []),
    ])
    .gte('created_at', since)
    .limit(50);
  if (error || !Array.isArray(data)) return false;
  return data.some((row: any) => {
    const action = row?.payload?.action ?? {};
    const params = action.params ?? {};
    return (
      (row.action_type === resolved.payload.operation ||
        (isExtendedActionsEnabled() &&
          isExtendedOperation(resolved.payload.operation) &&
          lockFamilyMembers(resolved.payload.operation).includes(row.action_type))) &&
      (action.target_id === resolved.sameTargetKey || params.budget_resource === resolved.sameTargetKey)
    );
  });
}

function cardFor(
  resolved: Resolved,
  id: string,
  why: string,
  created: boolean,
  canApprove: boolean
): Extract<ChatCard, { kind: 'proposal' }> {
  const label = operationLabelAr(resolved.payload.operation) ?? 'تعديل';
  return {
    kind: 'proposal',
    recommendationId: id,
    title: `${label}: ${resolved.targetLabel}`.slice(0, 120),
    why,
    changes: resolved.changes,
    warnings: resolved.warnings,
    size: resolved.size,
    evidence: resolved.evidence,
    created,
    canApprove,
  };
}

export async function prepareChange(input: unknown, ctx: PrepareContext): Promise<PrepareOutcome> {
  try {
    if (ctx.proposalsThisTurn >= MAX_PROPOSALS_PER_TURN) {
      fail('turn_limit', 'وصلت حد ثلاث اقتراحات في الرد الواحد. اعرض اللي جهزته.');
    }
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const operation = String(args.operation ?? '') as PrepareOperation;
    const extendedOperation =
      (isExtendedActionsEnabled() && isExtendedPrepareOperation(operation)) ||
      (isAdsStudioActive() && isAdsStudioPrepareOperation(operation));
    if (!PREPARE_OPERATIONS.includes(operation) && !extendedOperation) fail('unknown_operation', 'العملية غير معروفة.');
    const why = text(args.why_ar, 400);
    if (!why) fail('why_required', 'اكتب سبب التعديل في why_ar.');

    if (operation === 'manual_steps') {
      const steps = (Array.isArray(args.steps_ar) ? args.steps_ar : []).map((s) => text(s, 200)).filter(Boolean).slice(0, 8);
      if (steps.length === 0) fail('steps_required', 'الخطوات اليدوية تحتاج steps_ar.');
      const title = text(args.headline_ar, 90) || 'خطوات تسويها بنفسك';
      return {
        ok: true,
        card: { kind: 'manual_steps', title, steps },
        recommendationId: null,
        created: false,
        modelText: 'طلعت بطاقة الخطوات اليدوية للعميل. ما فيها تنفيذ تلقائي.',
      };
    }

    if (ctx.writeAccess === 'read_only') {
      fail(
        'read_only_access',
        'صلاحيتنا على الحساب قراءة بس، فما نقدر ننفذ هذا التعديل. اكتبه كخطوات يدوية أو كرسالة لمدير الحساب.'
      );
    }
    const choices = args.choices && typeof args.choices === 'object' ? (args.choices as Record<string, unknown>) : {};
    const rows = resolveRefs(ctx, args.evidence_refs);
    const resolved = resolve(ctx, operation, rows, choices);

    const recommendationShape = { title: why, description: why, expected_impact: null };
    const action = buildExecutableAction(resolved.payload, recommendationShape, ctx.customerId);
    if (!action) fail('not_executable', 'التعديل ما عدّى فحص التنفيذ الآمن. لا تعرضه كاقتراح.');

    const guard = ctx.deps?.checkGuardrails ?? checkGuardrails;
    const safe = await guard(action!, ctx.accountId, ctx.admin);
    if (!safe) fail('blocked_by_guardrails', 'حدود الأمان رفضت التعديل (مثلاً الميزانية فوق السقف أو تغيّرت كثير اليوم).');

    const warnings = [...resolved.warnings];
    if (await changedRecently(ctx, resolved)) {
      warnings.unshift('نفس النوع من التعديل انطبق على نفس الحملة خلال آخر 7 أيام. الأفضل تنتظر لين تبان نتيجته.');
    }
    const finalResolved = { ...resolved, warnings };

    const fingerprint = actionFingerprint(ctx.accountId, {
      type: resolved.payload.operation,
      target_id: action!.target_id,
      params: action!.params,
    });
    const findBlocking = ctx.deps?.findBlocking ?? findBlockingAutopilotRecommendation;
    const existing = await findBlocking(ctx.admin, ctx.accountId, fingerprint, ctx.now.getTime());
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'approved') {
        return {
          ok: true,
          card: { ...cardFor(finalResolved, existing.id, why, false, ctx.subscriptionActive), status: existing.status },
          recommendationId: existing.id,
          created: false,
          modelText: 'نفس التعديل مجهز قبل وينتظر اعتماد العميل. طلعت له نفس البطاقة.',
        };
      }
      if (existing.status === 'executing') fail('already_running', 'نفس التعديل قاعد يتنفذ الحين.');
      // Autopilot treats applied/dismissed as permanent. In a conversation the
      // customer may ask again later (re-pause a campaign after a rollback,
      // revisit a «مو الحين»), so the chat waits a week instead of forever.
      const createdAt = existing.created_at ? new Date(existing.created_at).getTime() : Number.NaN;
      if (!Number.isFinite(createdAt) || ctx.now.getTime() - createdAt < REPROPOSE_AFTER_MS) {
        fail('already_handled', 'نفس التعديل انطبق أو رفضه العميل خلال آخر أسبوع. لا تقترحه مرة ثانية الحين.');
      }
    }

    // The nightly ad copy cards use a different fingerprint (the campaign or the exact replaced texts, not the new
    // words). A chat proposal for the same thing must not stack on top of a waiting one.
    if (isAdsStudioPrepareOperation(resolved.payload.operation)) {
      const op = resolved.payload.operation;
      const cronFingerprint =
        op === 'replace_rsa_assets'
          ? replaceFingerprint(
              ctx.accountId,
              String(action!.target_id),
              (((action!.params as any).replacements ?? []) as Array<{ field: string; old_text: string }>).map((r) => ({ field: r.field, text: r.old_text }))
            )
          : addFingerprint(ctx.accountId, op, String(action!.target_id));
      const waiting = await findBlocking(ctx.admin, ctx.accountId, cronFingerprint, ctx.now.getTime());
      if (waiting && (waiting.status === 'pending' || waiting.status === 'approved')) {
        return {
          ok: true,
          card: { ...cardFor(finalResolved, waiting.id, why, false, ctx.subscriptionActive), status: waiting.status },
          recommendationId: waiting.id,
          created: false,
          modelText: 'فيه بطاقة مجهزة قبل لنفس الشي وتنتظر اعتماد العميل. طلعت له نفس البطاقة.',
        };
      }
    }

    const { count, error: countError } = await ctx.admin
      .from('recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending')
      .eq('action_payload->>source', 'jarvis_chat');
    if (countError) fail('read_failed', 'ما قدرت أتأكد من الاقتراحات المفتوحة، جرب بعد شوي.');
    if ((count ?? 0) >= MAX_OPEN_CHAT_PROPOSALS) {
      fail('open_limit', 'فيه عشر اقتراحات مفتوحة من المحادثة. خل العميل يعتمدها أو يرفضها أول.');
    }

    const amount = Math.round(resolved.monthlyAmount * 100) / 100;
    const expectedImpact = {
      metric: resolved.monthlyAmount > 0 ? 'wasted_spend' : 'performance',
      delta_pct: 0,
      delta_sar_per_month: ctx.currencyCode === 'SAR' ? amount : 0,
      basis: 'evidence_rows',
    };
    const card = cardFor(finalResolved, '', why, true, ctx.subscriptionActive);
    const row = {
      account_id: ctx.accountId,
      fingerprint,
      category: categoryForAction(resolved.payload.operation),
      severity: severityForAction({ expected_impact: expectedImpact }),
      title: card.title,
      description: why,
      expected_impact: expectedImpact,
      action_payload: {
        operation: resolved.payload.operation,
        target_id: action!.target_id,
        params: action!.params,
        source: 'jarvis_chat',
        chat_session_id: ctx.sessionId,
        size_v1: resolved.size,
        evidence: resolved.evidence,
        warnings,
      },
      status: 'pending',
    };
    const { data, error } = await ctx.admin.from('recommendations').insert(row).select('id').maybeSingle();
    if (error || !data?.id) {
      if (error?.code === '23505') {
        const raced = await findBlocking(ctx.admin, ctx.accountId, fingerprint, ctx.now.getTime());
        if (raced) {
          return {
            ok: true,
            card: cardFor(finalResolved, raced.id, why, false, ctx.subscriptionActive),
            recommendationId: raced.id,
            created: false,
            modelText: 'نفس التعديل مجهز قبل وينتظر اعتماد العميل. طلعت له نفس البطاقة.',
          };
        }
      }
      fail('save_failed', 'ما قدرت أحفظ الاقتراح الحين. قل للعميل يجرب بعد شوي.');
    }

    return {
      ok: true,
      card: { ...card, recommendationId: data.id },
      recommendationId: data.id,
      created: true,
      modelText: ctx.subscriptionActive
        ? 'انحفظ الاقتراح وطلعت بطاقته بزر «اعتمد». ما تغير شي في الحساب لين يضغط العميل.'
        : 'انحفظ الاقتراح، والعميل بدون اشتراك فيشوف زر الاشتراك بدل الاعتماد. ما تغير شي في الحساب.',
    };
  } catch (error) {
    if (error instanceof PrepareError) return { ok: false, code: error.code, modelText: error.messageAr };
    console.warn('[jarvis] prepare_change failed', { name: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, code: 'internal', modelText: 'صار خطأ داخلي وما تجهز التعديل.' };
  }
}
