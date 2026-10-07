import { buildExecutableAction } from '../ai/executable-action';
import { formatCurrency, formatDateAr, formatNumberAr } from '../utils';

/**
 * Presentation model for one card in the approvals screen.
 *
 * Everything here is derived from the stored `action_payload`, the same object
 * the execute endpoint sends to Google Ads. Nothing in this file decides what
 * runs: it only turns that payload into Arabic the account owner can read
 * before they approve a change to their live account.
 */

type UnknownRecord = Record<string, unknown>;

export type ApprovalKind = 'executable' | 'campaign_opportunity' | 'campaign_draft' | 'manual_review';

export type ApprovalRecommendation = {
  id?: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  expected_impact?: unknown;
  action_payload?: unknown;
  applied_result?: unknown;
  execution_started_at?: string | null;
  created_at?: string | null;
};

export const ROLLBACK_WINDOW_DAYS = 30;
const ROLLBACK_WINDOW_MS = ROLLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** An `executing` claim older than this is treated as an unconfirmed outcome. */
export const EXECUTION_SETTLE_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

/**
 * Uses the exact acceptance rule the execute endpoint applies first, so a card
 * only offers "تنفيذ" when the endpoint would not dead-end it in
 * `manual_review_required`.
 */
export function approvalKind(rec: ApprovalRecommendation): ApprovalKind {
  const payload = asRecord(rec.action_payload);
  const operation = text(payload.operation);
  if (operation === 'build_campaign_opportunity') return 'campaign_opportunity';
  if (operation === 'manual_campaign_draft') return 'campaign_draft';
  return buildExecutableAction(rec.action_payload, rec) ? 'executable' : 'manual_review';
}

// ---------------------------------------------------------------------------
// Names instead of Google IDs
// ---------------------------------------------------------------------------

export type CampaignNameIndex = ReadonlyMap<string, string>;

export function buildCampaignNameIndex(
  rows: ReadonlyArray<{ google_campaign_id?: unknown; name?: unknown }> | null | undefined
): CampaignNameIndex {
  const index = new Map<string, string>();
  for (const row of rows ?? []) {
    const id = row.google_campaign_id === null || row.google_campaign_id === undefined ? '' : String(row.google_campaign_id).trim();
    const name = text(row.name);
    if (id && name) index.set(id, name);
  }
  return index;
}

/** `customers/123/campaigns/456` with type `campaigns` gives `456`. */
export function resourceId(resource: unknown, type: string): string | null {
  const value = text(resource);
  if (!value) return null;
  const match = value.match(new RegExp(`^customers/\\d+/${type}/([^/~]+)(?:~[^/]*)?$`));
  return match ? match[1] : null;
}

export type ChangeTarget = {
  campaignName: string | null;
  adGroupName: string | null;
  keywordText: string | null;
  /** Raw Google resource names, kept only for a collapsed support detail. */
  technicalIds: string[];
};

export function resolveChangeTarget(payload: unknown, campaigns: CampaignNameIndex = new Map()): ChangeTarget {
  const root = asRecord(payload);
  const params = asRecord(root.params);
  const details = asRecord(root.details);
  const evidence = asRecord(root.evidence);

  const campaignIds = [
    resourceId(params.campaign_resource, 'campaigns'),
    resourceId(details.campaign_resource_name, 'campaigns'),
    resourceId(evidence.source_resource, 'campaigns'),
    text(details.campaign_id) || (typeof details.campaign_id === 'number' ? String(details.campaign_id) : null),
  ].filter((value): value is string => Boolean(value));

  const campaignName =
    firstText(params.campaign_name, root.campaign_name, details.campaign_name) ??
    campaignIds.map((id) => campaigns.get(id)).find((name): name is string => Boolean(name)) ??
    null;

  const technicalIds = unique(
    [
      text(params.budget_resource),
      text(params.ad_group_resource),
      text(params.campaign_resource),
      text(root.target_id),
    ].filter((value): value is string => Boolean(value))
  );

  return {
    campaignName,
    adGroupName: firstText(params.ad_group_name, root.ad_group_name, details.ad_group_name),
    keywordText: firstText(params.keyword_text, root.keyword_text, details.search_term),
    technicalIds,
  };
}

export function campaignPhrase(name: string | null) {
  return name ? `حملة «${name}»` : 'حملة (الاسم غير متوفر)';
}

export function adGroupPhrase(name: string | null) {
  return name ? `مجموعة «${name}»` : 'مجموعة إعلانية (الاسم غير متوفر)';
}

// ---------------------------------------------------------------------------
// Google terms in Arabic
// ---------------------------------------------------------------------------

export const GOOGLE_TERMS_AR = {
  EXACT: 'مطابقة تامة',
  PHRASE: 'مطابقة العبارة',
  BROAD: 'مطابقة واسعة',
  tCPA: 'تكلفة التحويل المستهدفة',
  tROAS: 'العائد المستهدف على الإنفاق',
} as const;

export const GOOGLE_TERM_HINTS: Record<string, string> = {
  EXACT: 'تظهر الإعلانات لمن يبحث بهذه الكلمة أو بمعناها نفسه فقط',
  PHRASE: 'تظهر الإعلانات للبحث الذي يتضمن معنى العبارة',
  BROAD: 'تظهر الإعلانات لعمليات بحث قريبة من الكلمة ولو بصياغة مختلفة',
  tCPA: 'المبلغ الذي تحاول Google دفعه مقابل كل تحويل',
  tROAS: 'قيمة المبيعات المستهدفة مقابل الإنفاق. 350% تعني 3.5 ريال مبيعات لكل ريال إعلان',
};

export function matchTypeLabel(value: unknown) {
  const key = text(value).toUpperCase();
  return (GOOGLE_TERMS_AR as Record<string, string>)[key] ?? (key || 'غير محدد');
}

/** Google stores target ROAS as a ratio: 3.5 means 350%. */
export function formatRoasPercent(value: unknown): string | null {
  const ratio = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(ratio) || ratio <= 0) return null;
  return `${formatNumberAr(Math.round(ratio * 100))}%`;
}

export function microsToAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  return micros / 1_000_000;
}

function formatMicros(value: unknown, currency?: string | null) {
  const amount = microsToAmount(value);
  return amount === null ? null : formatCurrency(amount, currency);
}

const CAMPAIGN_TYPE_AR: Record<string, string> = {
  SEARCH: 'حملة بحث',
  PMAX: 'حملة أداء أقصى',
  DISPLAY: 'حملة الشبكة الإعلانية',
  SHOPPING: 'حملة تسوق',
  VIDEO: 'حملة فيديو',
};

const BIDDING_AR: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: 'زيادة التحويلات إلى أقصى حد',
  TARGET_ROAS: GOOGLE_TERMS_AR.tROAS,
  TARGET_CPA: GOOGLE_TERMS_AR.tCPA,
};

// ---------------------------------------------------------------------------
// What changes, exactly
// ---------------------------------------------------------------------------

export type ChangeRow = {
  label: string;
  /** Present for before/after rows. */
  current?: string;
  next?: string;
  /** Present for single-value rows. */
  value?: string;
  hint?: string;
};

export type ChangePreview = {
  operation: string;
  operationLabel: string;
  /** One line that states the change with names and amounts. */
  summary: string;
  rows: ChangeRow[];
  target: ChangeTarget;
};

const OPERATION_LABELS: Record<string, string> = {
  adjust_budget: 'تعديل ميزانية حملة',
  adjust_bid: 'تعديل هدف المزايدة',
  pause_keyword: 'إيقاف كلمة مفتاحية',
  pause_ad: 'إيقاف إعلان',
  add_negative_keyword: 'إضافة كلمة سلبية',
  add_keyword: 'إضافة كلمة مفتاحية',
  build_campaign_opportunity: 'فرصة حملة جديدة',
  manual_campaign_draft: 'مسودة حملة جديدة',
};

const READ_AT_EXECUTION = 'تُقرأ من Google Ads لحظة التنفيذ';

export function budgetDeltaPct(params: UnknownRecord): number | null {
  const current = microsToAmount(params.current_amount_micros);
  const next = microsToAmount(params.new_amount_micros);
  if (current !== null && next !== null) return ((next - current) / current) * 100;
  const delta = Number(params.delta_pct);
  return params.delta_pct !== undefined && params.delta_pct !== null && Number.isFinite(delta) && delta !== 0 ? delta : null;
}

function signedPct(value: number) {
  const rounded = Number(value.toFixed(1));
  // Explicit sign: the Arabic locale wraps a negative number in a bidi mark.
  return `${rounded > 0 ? '+' : rounded < 0 ? '-' : ''}${formatNumberAr(Math.abs(rounded))}%`;
}

export function buildChangePreview(
  payload: unknown,
  options: { campaigns?: CampaignNameIndex; currencyCode?: string | null } = {}
): ChangePreview | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const root = asRecord(payload);
  const params = asRecord(root.params);
  const operation = text(root.operation);
  const currency = options.currencyCode;
  const target = resolveChangeTarget(root, options.campaigns);
  const campaign = campaignPhrase(target.campaignName);
  const rows: ChangeRow[] = [];
  let summary = '';

  if (operation === 'adjust_budget') {
    const current = formatMicros(params.current_amount_micros, currency);
    const next = formatMicros(params.new_amount_micros, currency);
    const pct = budgetDeltaPct(params);
    rows.push({ label: 'الحملة', value: campaign });
    rows.push({
      label: 'الميزانية اليومية',
      current: current ?? READ_AT_EXECUTION,
      next: next ?? (pct !== null ? `${signedPct(pct)} من القيمة الحالية` : 'غير محددة'),
    });
    if (pct !== null && next) rows.push({ label: 'نسبة التغيير', value: signedPct(pct) });
    if (current && next) {
      summary = `ميزانية ${campaign} اليومية من ${current} إلى ${next}`;
    } else if (pct !== null) {
      summary = `ميزانية ${campaign} اليومية ${pct > 0 ? 'ترتفع' : 'تنخفض'} ${formatNumberAr(Math.abs(Number(pct.toFixed(1))))}%`;
    } else {
      summary = `تعديل ميزانية ${campaign} اليومية`;
    }
  } else if (operation === 'adjust_bid') {
    const group = adGroupPhrase(target.adGroupName);
    rows.push({ label: 'المجموعة الإعلانية', value: group });
    if (target.campaignName) rows.push({ label: 'الحملة', value: campaign });
    if (params.target_cpa_micros !== undefined) {
      const current = formatMicros(params.current_target_cpa_micros, currency);
      const next = formatMicros(params.target_cpa_micros, currency) ?? 'غير محددة';
      rows.push({ label: GOOGLE_TERMS_AR.tCPA, current: current ?? READ_AT_EXECUTION, next, hint: GOOGLE_TERM_HINTS.tCPA });
      summary = current
        ? `${GOOGLE_TERMS_AR.tCPA} في ${group} من ${current} إلى ${next}`
        : `${GOOGLE_TERMS_AR.tCPA} في ${group} تصبح ${next}`;
    } else if (params.target_roas !== undefined) {
      const current = formatRoasPercent(params.current_target_roas);
      const next = formatRoasPercent(params.target_roas) ?? 'غير محدد';
      rows.push({ label: GOOGLE_TERMS_AR.tROAS, current: current ?? READ_AT_EXECUTION, next, hint: GOOGLE_TERM_HINTS.tROAS });
      summary = current
        ? `${GOOGLE_TERMS_AR.tROAS} في ${group} من ${current} إلى ${next}`
        : `${GOOGLE_TERMS_AR.tROAS} في ${group} يصبح ${next}`;
    } else {
      summary = `تعديل هدف المزايدة في ${group}`;
    }
  } else if (operation === 'add_negative_keyword') {
    const term = target.keywordText ?? 'غير محددة';
    const match = matchTypeLabel(params.match_type);
    rows.push({ label: 'الكلمة السلبية', value: `«${term}»` });
    rows.push({ label: 'نوع المطابقة', value: match, hint: GOOGLE_TERM_HINTS[text(params.match_type).toUpperCase()] });
    rows.push({ label: 'الحملة', value: campaign });
    summary = `إيقاف ظهور إعلانات ${campaign} لعبارة «${term}» (${match})`;
  } else if (operation === 'add_keyword') {
    const term = target.keywordText ?? 'غير محددة';
    const match = matchTypeLabel(params.match_type);
    const group = adGroupPhrase(target.adGroupName);
    rows.push({ label: 'الكلمة الجديدة', value: `«${term}»` });
    rows.push({ label: 'نوع المطابقة', value: match, hint: GOOGLE_TERM_HINTS[text(params.match_type).toUpperCase()] });
    rows.push({ label: 'المجموعة الإعلانية', value: group });
    if (target.campaignName) rows.push({ label: 'الحملة', value: campaign });
    summary = `إضافة «${term}» كلمة مفتاحية (${match}) في ${group}`;
  } else if (operation === 'pause_keyword') {
    if (target.keywordText) rows.push({ label: 'الكلمة', value: `«${target.keywordText}»` });
    if (target.campaignName) rows.push({ label: 'الحملة', value: campaign });
    rows.push({ label: 'الحالة', current: 'تعمل', next: 'موقوفة' });
    summary = `إيقاف ${target.keywordText ? `الكلمة «${target.keywordText}»` : 'كلمة مفتاحية'}${target.campaignName ? ` في ${campaign}` : ''}`;
  } else if (operation === 'pause_ad') {
    if (target.adGroupName) rows.push({ label: 'المجموعة الإعلانية', value: adGroupPhrase(target.adGroupName) });
    if (target.campaignName) rows.push({ label: 'الحملة', value: campaign });
    rows.push({ label: 'الحالة', current: 'يعمل', next: 'موقوف' });
    summary = `إيقاف إعلان${target.adGroupName ? ` في ${adGroupPhrase(target.adGroupName)}` : target.campaignName ? ` في ${campaign}` : ''}`;
  } else if (operation === 'build_campaign_opportunity') {
    const terms: unknown[] = Array.isArray(root.terms) ? root.terms : [];
    for (const raw of terms.slice(0, 5)) {
      const term = asRecord(raw);
      rows.push({
        label: `«${text(term.term) || 'عبارة'}»`,
        value: `${conversionsPhrase(Number(term.conversions ?? 0))} بتكلفة ${formatCurrency(Number(term.cost ?? 0), currency)}`,
      });
    }
    const totals = asRecord(root.totals);
    if (Number(totals.conversions) > 0) {
      rows.push({
        label: 'الإجمالي في آخر 30 يوماً',
        value: `${conversionsPhrase(Number(totals.conversions))} بتكلفة ${formatCurrency(Number(totals.cost ?? 0), currency)}`,
      });
    }
    summary = 'حملة جديدة تُبنى في المساعد من عبارات بحث جابت تحويلات';
  } else if (operation === 'manual_campaign_draft') {
    const name = text(params.name);
    const budget = Number(params.daily_budget_sar);
    if (name) rows.push({ label: 'اسم الحملة', value: `«${name}»` });
    const type = CAMPAIGN_TYPE_AR[text(params.type).toUpperCase()];
    if (type) rows.push({ label: 'النوع', value: type });
    if (Number.isFinite(budget) && budget > 0) rows.push({ label: 'الميزانية اليومية المقترحة', value: formatCurrency(budget, currency) });
    const bidding = BIDDING_AR[text(params.bidding_strategy).toUpperCase()];
    if (bidding) rows.push({ label: 'استراتيجية المزايدة', value: bidding });
    summary = `مسودة ${name ? `حملة «${name}»` : 'حملة جديدة'} لم تُنشأ في Google Ads بعد`;
  } else {
    if (target.campaignName) rows.push({ label: 'الحملة', value: campaign });
    if (target.adGroupName) rows.push({ label: 'المجموعة الإعلانية', value: adGroupPhrase(target.adGroupName) });
    summary = 'توصية للمراجعة اليدوية ولا تغيّر شيئاً في حسابك تلقائياً';
  }

  return {
    operation,
    operationLabel: OPERATION_LABELS[operation] ?? 'مراجعة يدوية',
    summary,
    rows,
    target,
  };
}

type CountForms = { one: string; two: string; few: string; many: string; other: string };

/** Arabic number agreement with Latin digits: 1, 2, 3 to 10, 11 to 99, rest. */
export function arabicCount(count: number, forms: CountForms) {
  const n = Number.isFinite(count) ? Math.round(count * 10) / 10 : 0;
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (!Number.isInteger(n) || n <= 0) return `${formatNumberAr(n)} ${forms.other}`;
  const tail = n % 100;
  if (tail >= 3 && tail <= 10) return `${formatNumberAr(n)} ${forms.few}`;
  if (tail >= 11 && tail <= 99) return `${formatNumberAr(n)} ${forms.many}`;
  return `${formatNumberAr(n)} ${forms.other}`;
}

export function conversionsPhrase(count: number) {
  return arabicCount(count, { one: 'تحويل واحد', two: 'تحويلان', few: 'تحويلات', many: 'تحويلاً', other: 'تحويل' });
}

export function clicksPhrase(count: number) {
  return arabicCount(count, { one: 'نقرة واحدة', two: 'نقرتان', few: 'نقرات', many: 'نقرة', other: 'نقرة' });
}

// ---------------------------------------------------------------------------
// Impact, risk, undo
// ---------------------------------------------------------------------------

export type ImpactLabel = 'توفير متوقع شهرياً' | 'زيادة متوقعة شهرياً';
export type ExpectedImpact = { label: ImpactLabel; amount: number };

const SAVING_OPERATIONS = new Set(['pause_keyword', 'pause_ad', 'add_negative_keyword']);
const GROWTH_OPERATIONS = new Set(['add_keyword', 'build_campaign_opportunity']);
const SAVING_METRICS = new Set(['cost', 'cpa', 'spend', 'waste']);

export function expectedImpact(rec: Pick<ApprovalRecommendation, 'expected_impact' | 'action_payload'>): ExpectedImpact | null {
  const impact = asRecord(rec.expected_impact);
  const amount = Number(impact.delta_sar_per_month);
  if (!Number.isFinite(amount) || amount <= 0 || impact.confidence === 'draft') return null;

  const payload = asRecord(rec.action_payload);
  const operation = text(payload.operation);
  let saving: boolean;
  if (SAVING_OPERATIONS.has(operation)) saving = true;
  else if (GROWTH_OPERATIONS.has(operation)) saving = false;
  else if (operation === 'adjust_budget') {
    const pct = budgetDeltaPct(asRecord(payload.params));
    saving = pct !== null ? pct < 0 : SAVING_METRICS.has(text(impact.metric).toLowerCase());
  } else saving = SAVING_METRICS.has(text(impact.metric).toLowerCase());

  return { label: saving ? 'توفير متوقع شهرياً' : 'زيادة متوقعة شهرياً', amount };
}

export type RiskLevel = 'low' | 'medium' | 'high';
export type Risk = { level: RiskLevel; label: 'منخفضة' | 'متوسطة' | 'مرتفعة'; reason: string };

export function riskOf(payload: unknown, kind: ApprovalKind): Risk | null {
  if (kind !== 'executable') return null;
  const root = asRecord(payload);
  const operation = text(root.operation);
  if (operation === 'adjust_budget') {
    const pct = budgetDeltaPct(asRecord(root.params));
    if (pct !== null && Math.abs(pct) >= 20) {
      return { level: 'high', label: 'مرتفعة', reason: 'يغيّر إنفاق الحملة اليومي بنسبة كبيرة' };
    }
    return { level: 'medium', label: 'متوسطة', reason: 'يغيّر إنفاق الحملة اليومي' };
  }
  if (operation === 'adjust_bid') {
    return { level: 'medium', label: 'متوسطة', reason: 'يغيّر طريقة مزايدة Google في مجموعة إعلانية كاملة' };
  }
  return { level: 'low', label: 'منخفضة', reason: 'يخص عنصراً واحداً ويمكن التراجع عنه' };
}

export function undoPolicy(kind: ApprovalKind) {
  if (kind === 'executable') return `يمكن التراجع من السجل خلال ${formatNumberAr(ROLLBACK_WINDOW_DAYS)} يوماً من التنفيذ`;
  if (kind === 'manual_review') return 'لا يغيّر شيئاً في Google Ads من هنا';
  return 'لا يُنشأ شيء في Google Ads قبل مراجعتك في المساعد';
}

/** Two lines restated in the confirmation panel before a live change is sent. */
export function executionConfirmationLines(preview: ChangePreview | null, title?: string | null): [string, string] {
  const first = preview?.summary || text(title) || 'تعديل على حسابك في Google Ads';
  return [first, `يُطبَّق الآن على حسابك في Google Ads ويمكن التراجع خلال ${formatNumberAr(ROLLBACK_WINDOW_DAYS)} يوماً`];
}

export function rollbackDeadline(createdAt: string | null | undefined): Date | null {
  if (!createdAt) return null;
  const time = new Date(createdAt).getTime();
  return Number.isFinite(time) ? new Date(time + ROLLBACK_WINDOW_MS) : null;
}

export function rollbackDeadlineLabel(createdAt: string | null | undefined) {
  const deadline = rollbackDeadline(createdAt);
  return deadline ? `يمكن التراجع حتى ${formatDateAr(deadline)}` : null;
}

type RollbackCandidate = {
  rollback_payload?: unknown;
  rollback_status?: string | null;
  reverted_at?: string | null;
  created_at?: string | null;
};

/** Mirrors the rollback endpoint's own preconditions; display only. */
export function canRollback(action: RollbackCandidate, now = Date.now()) {
  if (!asRecord(action.rollback_payload).reversible || action.reverted_at || action.rollback_status === 'executing') return false;
  const deadline = rollbackDeadline(action.created_at);
  return deadline !== null && now <= deadline.getTime();
}

// ---------------------------------------------------------------------------
// List split and stuck states
// ---------------------------------------------------------------------------

export type RecommendationGroups<T> = {
  pending: T[];
  approved: T[];
  attention: T[];
  dismissed: T[];
  applied: T[];
};

export function groupRecommendations<T extends { status?: string | null }>(recs: readonly T[]): RecommendationGroups<T> {
  const groups: RecommendationGroups<T> = { pending: [], approved: [], attention: [], dismissed: [], applied: [] };
  for (const rec of recs) {
    if (rec.status === 'pending') groups.pending.push(rec);
    else if (rec.status === 'approved') groups.approved.push(rec);
    else if (rec.status === 'executing' || rec.status === 'failed') groups.attention.push(rec);
    else if (rec.status === 'dismissed') groups.dismissed.push(rec);
    else if (rec.status === 'applied') groups.applied.push(rec);
  }
  return groups;
}

export type Attention = {
  state: 'in_progress' | 'unconfirmed' | 'failed' | 'rollback_unconfirmed' | 'rollback_failed';
  tone: 'warning' | 'danger';
  title: string;
  reason: string;
  nextStep: string;
};

const FAILURE_REASONS: Record<string, string> = {
  preflight_failed: 'تعذر قراءة القيمة الحالية من Google Ads قبل التنفيذ، فأوقفنا العملية',
  blocked_by_guardrails: 'أوقفتها ضوابط الأمان قبل أن تصل إلى Google Ads',
  resource_account_mismatch: 'العنصر المستهدف لا يتبع الحساب المختار، فأوقفنا العملية',
  execution_failed: 'تعذر تطبيق التعديل في Google Ads ولم يُطبَّق شيء',
};

export function recommendationAttention(rec: ApprovalRecommendation, now = Date.now()): Attention | null {
  if (rec.status === 'executing') {
    const started = rec.execution_started_at ? new Date(rec.execution_started_at).getTime() : NaN;
    if (Number.isFinite(started) && now - started < EXECUTION_SETTLE_MS) {
      return {
        state: 'in_progress',
        tone: 'warning',
        title: 'قيد التنفيذ الآن',
        reason: 'أرسلنا التعديل إلى Google Ads وننتظر التأكيد',
        nextStep: 'حدّث الصفحة بعد دقيقة ولا تكرر الطلب',
      };
    }
    return {
      state: 'unconfirmed',
      tone: 'danger',
      title: 'نتيجة التنفيذ غير مؤكدة',
      reason: 'لم يصلنا تأكيد من Google Ads وقد يكون التعديل طُبق فعلاً. أقفلنا التوصية حتى لا يتكرر التعديل',
      nextStep: 'راجع سجل التغييرات في Google Ads ثم تواصل مع الدعم لمطابقة النتيجة',
    };
  }
  if (rec.status === 'failed') {
    const status = text(asRecord(rec.applied_result).status);
    return {
      state: 'failed',
      tone: 'danger',
      title: 'لم يُنفَّذ التعديل',
      reason: FAILURE_REASONS[status] ?? 'لم يكتمل التنفيذ ولم نعتبر التعديل مطبقاً',
      nextStep: 'حدّث البيانات ثم اعتمدها من جديد أو تجاهلها',
    };
  }
  return null;
}

type RollbackState = {
  rollback_status?: string | null;
  rollback_started_at?: string | null;
  reverted_at?: string | null;
};

export function rollbackAttention(action: RollbackState, now = Date.now()): Attention | null {
  if (action.reverted_at) return null;
  if (action.rollback_status === 'executing') {
    const started = action.rollback_started_at ? new Date(action.rollback_started_at).getTime() : NaN;
    if (Number.isFinite(started) && now - started < EXECUTION_SETTLE_MS) {
      return {
        state: 'in_progress',
        tone: 'warning',
        title: 'التراجع قيد التنفيذ',
        reason: 'أرسلنا التراجع إلى Google Ads وننتظر التأكيد',
        nextStep: 'حدّث الصفحة بعد دقيقة ولا تكرر الطلب',
      };
    }
    return {
      state: 'rollback_unconfirmed',
      tone: 'danger',
      title: 'نتيجة التراجع غير مؤكدة',
      reason: 'لم يصلنا تأكيد من Google Ads على التراجع. أقفلناه حتى لا يتكرر',
      nextStep: 'راجع سجل التغييرات في Google Ads ثم تواصل مع الدعم لمطابقة النتيجة',
    };
  }
  if (action.rollback_status === 'failed') {
    return {
      state: 'rollback_failed',
      tone: 'danger',
      title: 'تعذر التراجع',
      reason: 'التعديل الأصلي ما زال مطبقاً في Google Ads',
      nextStep: 'أعد محاولة التراجع من السجل أو عدّل القيمة من Google Ads مباشرة',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const t = text(value);
    if (t) return t;
  }
  return null;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
