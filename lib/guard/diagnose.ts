/**
 * Automatic incident diagnosis: the root-cause tree of the Google Ads Titan
 * skill (operations-diagnostics 11.2), run as rules over what the guard already
 * read. First hit is the "most likely cause", the others ride along as
 * "also possible". No model, no extra Google call.
 *
 * Order (11.2): tracking, recent changes, budget and bid limits (campaign
 * state included), disapprovals, auction. One deliberate exception: when
 * spend STOPPED and the account itself is suspended, has no live billing setup
 * or has spent its approved limit, that is checked first, because no other
 * cause can explain zero spend and 11.3 ("الصرف وقف") starts there too. The
 * site and landing page (11.2 step 2), demand and season (6) and Google's own
 * platform changes (8) cannot be read from the account, so they are not here.
 */
import { WHATSAPP_LINE, RESOURCE_TYPE_AR, ACTOR_AR, cleanName, percent } from './copy';
import { changeActor, isMaterialChange, isOwnChange, buildSeries, median } from './detectors';
import type { CauseCode, ChangeRow, GuardCause, GuardFinding, GuardSignals } from './types';

export type DiagnosisKind = 'spend_zero' | 'spend_spike' | 'cpa_spike' | 'conversions_zero';

export const RECENT_CHANGE_LOOKBACK_MS = 72 * 3_600_000;
/** Lost impression share from which the budget or the rank is called the limit. */
export const LOST_SHARE_LIMIT = 0.2;
export const RANK_LOST_LIMIT = 0.3;
export const IMPRESSION_SHARE_DROP = 0.7;

const CAMPAIGN_STATE_AR: Record<string, string> = {
  CAMPAIGN_PAUSED: 'موقوفة',
  CAMPAIGN_ENDED: 'انتهت مدتها',
  CAMPAIGN_PENDING: 'ما بدأت بعد',
  CAMPAIGN_GROUP_PAUSED: 'مجموعتها موقوفة',
  AD_GROUPS_PAUSED: 'مجموعاتها الإعلانية موقوفة',
  NO_AD_GROUPS: 'ما فيها مجموعات إعلانية',
  KEYWORDS_PAUSED: 'كلماتها موقوفة',
  NO_KEYWORDS: 'ما فيها كلمات',
  AD_GROUP_ADS_PAUSED: 'إعلاناتها موقوفة',
  NO_AD_GROUP_ADS: 'ما فيها إعلانات',
  ASSET_GROUPS_PAUSED: 'مجموعات أصولها موقوفة',
};
const BUDGET_REASONS = new Set(['BUDGET_CONSTRAINED', 'BUDGET_MISCONFIGURED']);
const BID_REASONS = new Set([
  'BIDDING_STRATEGY_MISCONFIGURED',
  'BIDDING_STRATEGY_LIMITED',
  'BIDDING_STRATEGY_CONSTRAINED',
  'BIDDING_STRATEGY_LEARNING',
]);
const POLICY_REASONS = new Set([
  'HAS_ADS_DISAPPROVED',
  'HAS_ADS_LIMITED_BY_POLICY',
  'HAS_ASSET_GROUPS_DISAPPROVED',
  'HAS_ASSET_GROUPS_LIMITED_BY_POLICY',
]);

type Scope = { ids: Set<string> | null }; // null = whole account

function inScope(scope: Scope, campaignId: string | null) {
  return scope.ids === null || (campaignId !== null && scope.ids.has(campaignId));
}

// 0. Hard blockers, only for "spend stopped".
function hardBlocker(signals: GuardSignals, accountFindings: GuardFinding[]): GuardCause | null {
  const blocker = accountFindings.find((f) =>
    ['account_status', 'billing_setup'].includes(f.code) || (f.code === 'billing_budget' && f.dedupeKey.includes(':exhausted:'))
  );
  if (!blocker) return null;
  return {
    code: 'billing',
    labelAr: blocker.whatAr,
    stepAr: blocker.stepAr,
    evidence: { finding: blocker.code, ...blocker.evidence },
  };
}

// 1. Tracking.
function tracking(kind: DiagnosisKind, signals: GuardSignals, scope: Scope, conversionsZeroIds: string[]): GuardCause | null {
  if (kind === 'spend_zero' || kind === 'spend_spike') return null;
  const rows = signals.daily.filter((r) => inScope(scope, r.campaignId));
  const series = buildSeries(rows, signals.yesterday);
  const clicksStable = series.medianClicks > 0 && series.yesterday.clicks >= 0.7 * series.medianClicks;
  const convMedian = median(series.baseline.map((d) => d.conversions));
  const convDropped = series.yesterday.conversions < 0.5 * convMedian;
  const zeroFlagged = conversionsZeroIds.some((id) => inScope(scope, id));
  const hit = kind === 'conversions_zero' ? zeroFlagged || (convDropped && clicksStable) : convDropped && clicksStable;
  if (!hit) return null;
  return {
    code: 'tracking',
    labelAr: 'النقرات ماشية بس التحويلات نزلت، وهذا يشبه خلل في التتبع أكثر من نزول حقيقي',
    stepAr: 'افحص التتبع أول (التاق وحالة التحويل وهل الطلبات نزلت فعلاً) قبل أي تعديل في الحملات',
    evidence: {
      yesterday_clicks: series.yesterday.clicks,
      median_daily_clicks_14d: Math.round(series.medianClicks * 100) / 100,
      yesterday_conversions: Math.round(series.yesterday.conversions * 100) / 100,
      median_daily_conversions_14d: Math.round(convMedian * 100) / 100,
    },
  };
}

// 2. Recent changes (ours included, labelled as ours).
function recentChange(signals: GuardSignals, scope: Scope): GuardCause | null {
  const since = signals.now.getTime() - RECENT_CHANGE_LOOKBACK_MS;
  const relevant = signals.changes.filter(
    (c) => c.at >= since && isMaterialChange(c) && (scope.ids === null || (c.campaignId !== null && scope.ids.has(c.campaignId)))
  );
  if (relevant.length === 0) return null;
  const own = relevant.filter((c) => isOwnChange(c, signals.ownActions));
  const outside = relevant.filter((c) => !own.includes(c));
  const lead: ChangeRow[] = outside.length > 0 ? outside : own;
  const types = Array.from(new Set(lead.map((c) => RESOURCE_TYPE_AR[c.resourceType]).filter(Boolean))).slice(0, 3);
  const latest = Math.max(...lead.map((c) => c.at));
  const label =
    outside.length > 0
      ? `صار تعديل قبل التغيّر بواسطة ${ACTOR_AR[changeActor(lead[0].clientType)]}${types.length ? ` (${types.join('، ')})` : ''}`
      : `آخر تعديل على الحساب كان تعديلنا اللي اعتمدته${types.length ? ` (${types.join('، ')})` : ''}`;
  return {
    code: 'recent_change',
    labelAr: label,
    stepAr:
      outside.length > 0
        ? 'راجع التعديل في سجل التغييرات، ولو مو انت اللي سويته قل لنا'
        : 'لو التعديل ما عجبك ترجّعه من الرئيسية خلال 30 يوم',
    evidence: {
      changes_72h: relevant.length,
      outside: outside.length,
      ours: own.length,
      latest_at: new Date(latest).toISOString(),
      by_type: Object.fromEntries(
        Array.from(new Set(lead.map((c) => c.resourceType))).map((t) => [t, lead.filter((c) => c.resourceType === t).length])
      ),
    },
  };
}

// 3. Budget and bid limits, and campaign state.
function limits(kind: DiagnosisKind, signals: GuardSignals, scope: Scope): GuardCause | null {
  const infos = signals.campaigns.filter((c) => inScope(scope, c.id));
  const state = infos.find((c) => c.primaryReasons.some((r) => CAMPAIGN_STATE_AR[r]));
  if (state && kind === 'spend_zero') {
    const reason = state.primaryReasons.find((r) => CAMPAIGN_STATE_AR[r])!;
    return {
      code: 'campaign_state',
      labelAr: `حملة "${cleanName(state.name)}" ${CAMPAIGN_STATE_AR[reason]}`,
      stepAr: 'شغّل اللي واقف أو قل لنا لو تبي نشوف معك ليش وقف',
      evidence: { campaign: cleanName(state.name), reasons: state.primaryReasons.slice(0, 4) },
    };
  }
  const budget = infos.find((c) => c.primaryReasons.some((r) => BUDGET_REASONS.has(r)) || (c.budgetLostIs ?? 0) >= LOST_SHARE_LIMIT);
  if (budget) {
    return {
      code: 'budget_limit',
      labelAr: `الميزانية اليومية تحد ظهور حملة "${cleanName(budget.name)}"${budget.budgetLostIs !== null ? ` وخسرت ${percent(budget.budgetLostIs)} من الظهور بسببها` : ''}`,
      stepAr: 'اقرأ الميزانية مقابل تكلفة التحويلة قبل ما ترفعها، وقل لنا لو تبي نجهز لك قرار',
      evidence: { campaign: cleanName(budget.name), budget_lost_is: budget.budgetLostIs, daily_budget: budget.dailyBudget, reasons: budget.primaryReasons.slice(0, 4) },
    };
  }
  const bid = infos.find((c) => c.primaryReasons.some((r) => BID_REASONS.has(r)));
  if (bid) {
    return {
      code: 'bidding',
      labelAr: `استراتيجية المزايدة في حملة "${cleanName(bid.name)}" محدودة أو تتعلم`,
      stepAr: 'لا تغيّر الهدف أو الاستراتيجية الحين، خلها تخلص فترة التعلم وراجعها بعد كم يوم',
      evidence: { campaign: cleanName(bid.name), reasons: bid.primaryReasons.slice(0, 4) },
    };
  }
  return null;
}

// 4. Disapprovals.
function disapproval(signals: GuardSignals, scope: Scope): GuardCause | null {
  const ads = signals.ads.filter((a) => inScope(scope, a.campaignId));
  const flagged = signals.campaigns.filter((c) => inScope(scope, c.id) && c.primaryReasons.some((r) => POLICY_REASONS.has(r)));
  if (ads.length === 0 && flagged.length === 0) return null;
  const disapproved = ads.filter((a) => a.approval === 'DISAPPROVED').length;
  return {
    code: 'disapproval',
    labelAr:
      ads.length > 0
        ? `${ads.length} إعلان مرفوض أو محدود بسبب سياسة قوقل`
        : 'قوقل يقول في إعلانات مرفوضة أو محدودة بسبب السياسة',
    stepAr: `ما نعدّل شي بنفسنا هنا. ${WHATSAPP_LINE} وندلك على التصحيح قبل أي استئناف`,
    evidence: { ads: ads.length, disapproved, campaigns_flagged: flagged.length },
  };
}

// 5. Auction.
function auction(signals: GuardSignals, scope: Scope): GuardCause | null {
  const infos = signals.campaigns.filter((c) => inScope(scope, c.id));
  const rank = infos.find((c) => (c.rankLostIs ?? 0) >= RANK_LOST_LIMIT);
  const dropped = infos.find(
    (c) => c.impressionShare !== null && c.baselineImpressionShare !== null && c.baselineImpressionShare > 0 && c.impressionShare < IMPRESSION_SHARE_DROP * c.baselineImpressionShare
  );
  const hit = rank ?? dropped;
  if (!hit) return null;
  return {
    code: 'auction',
    labelAr: rank
      ? `حملة "${cleanName(rank.name)}" خسرت ${percent(rank.rankLostIs ?? 0)} من الظهور بسبب الترتيب، وهذا يعني منافسة أقوى أو جودة أقل`
      : `حصة الظهور في حملة "${cleanName(hit.name)}" نزلت عن معدلها`,
    stepAr: 'شوف تقرير المنافسين في قوقل أدز، وراجع جودة الإعلان والصفحة قبل ما ترفع المزايدة',
    evidence: { campaign: cleanName(hit.name), rank_lost_is: hit.rankLostIs, impression_share: hit.impressionShare, baseline_impression_share: hit.baselineImpressionShare },
  };
}

const UNKNOWN: GuardCause = {
  code: 'unknown',
  labelAr: 'ما لقيت سبب واضح من القراءة الآلية',
  stepAr: `${WHATSAPP_LINE} ونفحصه معك يدوياً`,
  evidence: {},
};

/**
 * Attaches the likely cause to one spend or results finding.
 * `accountFindings` are this account's findings of the same run (the hard
 * blockers), `conversionsZeroIds` the campaigns the tracking rule flagged.
 */
export function diagnoseFinding(
  finding: GuardFinding,
  signals: GuardSignals,
  accountFindings: GuardFinding[],
  conversionsZeroIds: string[]
): GuardFinding {
  const kind = finding.code as DiagnosisKind;
  const scope: Scope = {
    ids: finding.entityType === 'campaign' ? new Set([finding.entityId]) : kind === 'conversions_zero' ? new Set(conversionsZeroIds) : null,
  };
  const candidates: Array<GuardCause | null> = [
    kind === 'spend_zero' ? hardBlocker(signals, accountFindings) : null,
    tracking(kind, signals, scope, conversionsZeroIds),
    signals.ok.changes ? recentChange(signals, scope) : null,
    signals.ok.campaigns ? limits(kind, signals, scope) : null,
    signals.ok.ads ? disapproval(signals, scope) : null,
    signals.ok.campaigns ? auction(signals, scope) : null,
  ];
  const hits = candidates.filter((c): c is GuardCause => c !== null);
  const top = hits[0] ?? UNKNOWN;
  const cause: GuardCause = {
    ...top,
    evidence: { ...top.evidence, also_possible: hits.slice(1).map((c) => c.code as CauseCode) },
  };
  return {
    ...finding,
    cause,
    // The step that goes with the likely cause beats the generic one.
    stepAr: top.code === 'unknown' ? finding.stepAr : top.stepAr,
    escalation: ['billing', 'disapproval'].includes(top.code) ? 'human' : finding.escalation,
  };
}

export function diagnoseAll(findings: GuardFinding[], signals: GuardSignals, conversionsZeroIds: string[]): GuardFinding[] {
  const targets = new Set<string>(['spend_zero', 'spend_spike', 'cpa_spike', 'conversions_zero']);
  return findings.map((f) => (targets.has(f.code) ? diagnoseFinding(f, signals, findings, conversionsZeroIds) : f));
}

