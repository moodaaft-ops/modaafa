/**
 * Launch gates for campaign drafts, aligned with the google-ads-titan
 * knowledge base. Pure functions: no model call, no database, no Google call.
 *
 * Why this exists: the campaign builder and the assistant used to propose
 * target bidding at any volume, BROAD match with no preconditions, PMax for any
 * brief, and a forecast made of constants. The knowledge base says the
 * opposite (titan red rule 8: no invented numbers; 3.4, 3.6, 3.9, 5.2, 8.1,
 * 20.2). The prompt tells the model the rules, and `applyBuilderGates` makes
 * them true in code even when the model ignores the prompt.
 *
 * Nothing here launches anything. A draft is a proposal that still needs the
 * owner's approval, and `status` is forced to PAUSED (titan red rule 4).
 */

/** Titan 3.5, 3.9, 5.2: target bidding starts at 30 conversions in 30 days. */
export const TARGET_BIDDING_MIN_CONVERSIONS_30D = 30;
/** Titan 8.1, 21: a store runs PMax only with a healthy feed and 30 conversions in 30 days. */
export const PMAX_MIN_CONVERSIONS_30D = 30;
/** Titan 20.2: BROAD needs a target strategy and 30 conversions a month ("عندنا نخليها 30"). */
export const BROAD_MIN_CONVERSIONS_30D = 30;
/** Titan 5.2 (Aaron Young): a stable CPA moves by no more than 20%. */
export const CPA_STABLE_MAX_DELTA_PCT = 20;
/** Titan 6.1.1: a click cap above budget/10 buys fewer than 10 clicks a day. */
export const CPC_CAP_BUDGET_DIVISOR = 10;

export type BuilderBidStrategy =
  | 'MAXIMIZE_CLICKS'
  | 'MANUAL_CPC'
  | 'MAXIMIZE_CONVERSIONS'
  | 'TARGET_CPA'
  | 'TARGET_ROAS';

export type BuilderCampaignType = 'SEARCH' | 'SHOPPING' | 'PMAX' | 'DISPLAY' | 'VIDEO';

export type BuilderObjective = 'SALES' | 'LEADS';

/**
 * What the platform knows about the account the draft is for. `null` means
 * unknown, and unknown always takes the conservative option.
 */
export type BuilderAccountSignals = {
  /** Account total over the last 30 days. */
  conversions_30d: number | null;
  /**
   * True only when conversions are arriving and nothing contradicts it (an
   * enabled conversion action exists and auto-tagging is not off). Titan 3.9:
   * "تحويلات تصل" is the line between Max Clicks and Max Conversions.
   */
  tracking_healthy: boolean | null;
  /** A campaign in the account already carries a Merchant Center id. */
  merchant_center_linked: boolean | null;
  /**
   * An enabled, primary uploaded-conversion action is receiving conversions
   * (lib/launch/pmax-inventory.ts). Only read when CAMPAIGN_LAUNCH_PMAX_ENABLED
   * is on; absent, null and false all keep PMAX for lead generation blocked.
   */
  offline_upload_in_place?: boolean | null;
};

export const UNKNOWN_BUILDER_SIGNALS: BuilderAccountSignals = {
  conversions_30d: null,
  tracking_healthy: null,
  merchant_center_linked: null,
};

export const FORECAST_UNAVAILABLE_REASON_AR =
  'ما نقدر نعطيك توقع للنقرات أو التحويلات أو التكلفة، لأن ما عندنا بيانات حجم بحث وأسعار نقرات حقيقية لكلماتك. أي رقم نكتبه الحين تخمين، وأول قراءة صادقة تجي من أول أسبوعين تشغيل.';

export type ForecastUnavailable = { available: false; reason_ar: string };

export function forecastUnavailable(): ForecastUnavailable {
  return { available: false, reason_ar: FORECAST_UNAVAILABLE_REASON_AR };
}

export const TARGET_FROM_ECONOMICS_AR =
  'قيمة الهدف تُحسب من هامش ربحك ونسبة إغلاق مبيعاتك، مو من متوسط تكلفة الحساب.';

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the account has the volume target bidding needs (30 conversions in 30 days). */
export function hasTargetBiddingVolume(conversions30d: unknown): boolean {
  const value = finiteOrNull(conversions30d);
  return value !== null && value >= TARGET_BIDDING_MIN_CONVERSIONS_30D;
}

/**
 * Stable CPA: the last 7 days against the 23 before it moved by no more than
 * 20%. An unknown delta is not stable.
 */
export function isCpaStable(cpaDeltaPct: unknown): boolean {
  const value = finiteOrNull(cpaDeltaPct);
  return value !== null && Math.abs(value) <= CPA_STABLE_MAX_DELTA_PCT;
}

/**
 * The strategy a NEW campaign may start with (titan 3.9):
 * - no conversions or unhealthy tracking: Maximize Clicks with a CPC cap
 * - conversions arriving: Maximize Conversions without a target
 * The target strategies are never a starting point for a draft; they are
 * allowed only by `allowedStrategies` when volume exists.
 */
export function defaultStrategy(signals: BuilderAccountSignals): BuilderBidStrategy {
  return signals.tracking_healthy === true && (signals.conversions_30d ?? 0) >= 1
    ? 'MAXIMIZE_CONVERSIONS'
    : 'MAXIMIZE_CLICKS';
}

/** The strategies a draft for this account may use. Target bidding needs volume (titan 5.2). */
export function allowedStrategies(
  signals: BuilderAccountSignals,
  objective: BuilderObjective | null
): BuilderBidStrategy[] {
  const allowed: BuilderBidStrategy[] = ['MAXIMIZE_CLICKS', 'MANUAL_CPC'];
  if (defaultStrategy(signals) === 'MAXIMIZE_CONVERSIONS') allowed.push('MAXIMIZE_CONVERSIONS');
  if (signals.tracking_healthy === true && hasTargetBiddingVolume(signals.conversions_30d)) {
    allowed.push('TARGET_CPA');
    // Titan 5.2: ROAS targets need real, varying conversion values, which a lead brief does not have.
    if (objective !== 'LEADS') allowed.push('TARGET_ROAS');
  }
  return allowed;
}

/** Maps the names a model (or older code) may use onto the strategies above; null when unknown. */
export function normalizeStrategy(value: unknown): BuilderBidStrategy | null {
  const raw = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  switch (raw) {
    case 'MAXIMIZE_CLICKS':
    case 'TARGET_SPEND':
      return 'MAXIMIZE_CLICKS';
    case 'MANUAL_CPC':
      return 'MANUAL_CPC';
    case 'MAXIMIZE_CONVERSIONS':
      return 'MAXIMIZE_CONVERSIONS';
    case 'TARGET_CPA':
    case 'MAXIMIZE_CONVERSIONS_WITH_TARGET_CPA':
      return 'TARGET_CPA';
    case 'TARGET_ROAS':
      return 'TARGET_ROAS';
    default:
      return null;
  }
}

const STRATEGY_NOTE_AR: Record<BuilderBidStrategy, string> = {
  MAXIMIZE_CLICKS:
    'نبدأ بتعظيم النقرات مع سقف لسعر النقرة، عشان تتجمع بيانات حقيقية وتتسجل التحويلات صح. بعدها ننتقل لتعظيم التحويلات.',
  MANUAL_CPC:
    'نبدأ بنقرة يدوية مع سقف لسعر النقرة، عشان تتجمع بيانات حقيقية قبل أي استراتيجية ذكية.',
  MAXIMIZE_CONVERSIONS:
    'التحويلات تتسجل عندك وهي تحت 30 في الشهر، فنبدأ بتعظيم التحويلات بدون هدف تكلفة.',
  TARGET_CPA: `وصلت 30 تحويل أو أكثر في آخر 30 يوم، فصار الهدف على تكلفة التحويل ممكن. ${TARGET_FROM_ECONOMICS_AR}`,
  TARGET_ROAS: `وصلت 30 تحويل أو أكثر في آخر 30 يوم، فصار الهدف على العائد ممكن. ${TARGET_FROM_ECONOMICS_AR}`,
};

export function strategyNoteAr(strategy: BuilderBidStrategy): string {
  return STRATEGY_NOTE_AR[strategy];
}

// ---------------------------------------------------------------------------
// The assistant's draft (app/api/chat/assistant/route.ts)
// ---------------------------------------------------------------------------

export type AssistantBiddingChoice = {
  strategy: BuilderBidStrategy;
  note_ar: string;
  /** True when the choice is a target strategy whose value the merchant must supply. */
  needs_target_from_economics: boolean;
};

/**
 * The bidding strategy for the assistant's campaign draft, from the account's
 * own numbers: 30 conversions in 30 days AND a stable CPA before a target
 * strategy (titan 5.2), never "15 in 7 days". No target value comes from here:
 * the value belongs to the merchant's margin and close rate (titan red rule 2).
 */
export function assistantDraftBidding(args: {
  conversions30d: number | null | undefined;
  cpaDeltaPct: number | null | undefined;
}): AssistantBiddingChoice {
  const conversions = finiteOrNull(args.conversions30d) ?? 0;
  if (conversions >= TARGET_BIDDING_MIN_CONVERSIONS_30D && isCpaStable(args.cpaDeltaPct)) {
    return { strategy: 'TARGET_CPA', note_ar: STRATEGY_NOTE_AR.TARGET_CPA, needs_target_from_economics: true };
  }
  if (conversions >= 1) {
    const note =
      conversions >= TARGET_BIDDING_MIN_CONVERSIONS_30D
        ? 'عندك 30 تحويل أو أكثر لكن تكلفة التحويل ما استقرت بعد، فنبقى على تعظيم التحويلات بدون هدف لين تثبت.'
        : STRATEGY_NOTE_AR.MAXIMIZE_CONVERSIONS;
    return { strategy: 'MAXIMIZE_CONVERSIONS', note_ar: note, needs_target_from_economics: false };
  }
  return { strategy: 'MAXIMIZE_CLICKS', note_ar: STRATEGY_NOTE_AR.MAXIMIZE_CLICKS, needs_target_from_economics: false };
}

// ---------------------------------------------------------------------------
// Copy checks
// ---------------------------------------------------------------------------

/** Arabic and English guarantee wording. Ad copy never promises results (titan 8.2: delete "نجاح مضمون"). */
const GUARANTEE_WORDS = /ضمان|نضمن|مضمون|guarantee/i;

function normalizeArabic(text: string): string {
  return text.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْـ]/g, '');
}

export function mentionsGuarantee(text: string): boolean {
  return GUARANTEE_WORDS.test(text) || GUARANTEE_WORDS.test(normalizeArabic(text));
}

/** The brief itself names the campaign type: only then may a draft be DISPLAY or VIDEO (titan 3.4). */
const DISPLAY_ASK = /\b(display|banner)\b|ديسبلاي|ديسبلي|بانر|بنر|الشبكه\s*(?:ال)?اعلانيه/i;
const VIDEO_ASK = /\b(video|youtube)\b|فيديو|فديو|يوتيوب|يوتوب/i;

export function briefAsksForType(brief: string, type: 'DISPLAY' | 'VIDEO'): boolean {
  const text = normalizeArabic(String(brief ?? ''));
  return (type === 'DISPLAY' ? DISPLAY_ASK : VIDEO_ASK).test(text);
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

export type GateChange = {
  rule:
    | 'type_unsupported'
    | 'type_unrequested'
    | 'pmax_leads'
    | 'pmax_no_feed'
    | 'pmax_low_volume'
    | 'shopping_no_feed'
    | 'bidding'
    | 'broad_match'
    | 'cpc_cap_missing'
    | 'cpc_cap_high'
    | 'guarantee_copy'
    | 'location_option';
  from?: string;
  to?: string;
};

export type GateResult = {
  draft: Record<string, any>;
  /** What the gates changed or still need from the merchant, in Arabic, for the owner. */
  notes_ar: string[];
  changes: GateChange[];
};

const VALID_TYPES: readonly BuilderCampaignType[] = ['SEARCH', 'SHOPPING', 'PMAX', 'DISPLAY', 'VIDEO'];

function normalizeType(value: unknown): BuilderCampaignType | null {
  const raw = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (raw === 'PERFORMANCE_MAX') return 'PMAX';
  return (VALID_TYPES as readonly string[]).includes(raw) ? (raw as BuilderCampaignType) : null;
}

function normalizeObjective(value: unknown): BuilderObjective | null {
  const raw = String(value ?? '').trim().toUpperCase();
  return raw === 'SALES' || raw === 'LEADS' ? raw : null;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/**
 * Makes a campaign draft obey the knowledge base, whatever the model wrote.
 * Returns a normalized copy (the input is not mutated) plus Arabic notes for
 * every change and every input the merchant still owes.
 *
 * Gates (titan section in brackets):
 * - DISPLAY/VIDEO only when the brief asked for them [3.4]
 * - PMax for leads: never (no offline import exists here) [8.1]
 * - PMax for a store: Merchant Center feed and 30 conversions in 30 days, else Shopping or Search [8.1, 9.1, 21.12]
 * - Shopping needs a Merchant Center feed, else Search [9]
 * - bidding ladder: Max Clicks with a CPC cap, then Max Conversions when tracking is healthy, target strategies at 30 conversions in 30 days [3.9, 5.2]
 * - no numeric CPA/ROAS target from the builder: it belongs to the merchant's economics [red rule 2]
 * - BROAD only with a target strategy and 30 conversions, else PHRASE [20.2, 3.7]
 * - Search: Search Partners and Display Network off [3.6]
 * - location option PRESENCE unless a reason is given [3.6]
 * - created PAUSED [red rule 4]
 * - no forecast numbers [red rule 8]
 * - no guarantee wording [8.2]
 */
export function applyBuilderGates(
  rawDraft: unknown,
  ctx: { brief: string; signals?: BuilderAccountSignals | null }
): GateResult {
  const draft: Record<string, any> = structuredClone(asRecord(rawDraft) ?? {});
  const signals: BuilderAccountSignals = { ...UNKNOWN_BUILDER_SIGNALS, ...(ctx.signals ?? {}) };
  const notes: string[] = [];
  const changes: GateChange[] = [];
  const missing: string[] = Array.isArray(draft.missing_inputs_ar)
    ? draft.missing_inputs_ar.filter((item: unknown): item is string => typeof item === 'string')
    : [];
  const brief = String(ctx.brief ?? '');

  const objective = normalizeObjective(draft.objective);
  if (objective) draft.objective = objective;
  else delete draft.objective;

  // ---- Campaign type -------------------------------------------------------
  const requestedType = normalizeType(draft.type);
  let type: BuilderCampaignType = requestedType ?? 'SEARCH';
  const typeChange = (rule: GateChange['rule'], to: BuilderCampaignType, note: string) => {
    changes.push({ rule, from: String(draft.type ?? ''), to });
    notes.push(note);
    type = to;
  };

  if (!requestedType) {
    typeChange('type_unsupported', 'SEARCH', 'نوع الحملة اللي اقترحه المساعد مو مدعوم عندنا، فحوّلناه لحملة بحث.');
  }

  if ((type === 'DISPLAY' || type === 'VIDEO') && !briefAsksForType(brief, type)) {
    typeChange(
      'type_unrequested',
      'SEARCH',
      'حوّلنا الحملة لحملة بحث، لأنك ما طلبت حملة شبكة إعلانية أو فيديو. البحث أول، والباقي يجي بعد ما يثبت القياس.'
    );
  }

  if (type === 'PMAX') {
    if (objective === 'LEADS' && signals.offline_upload_in_place === true) {
      // Leads PMax is allowed only with the offline upload working (titan 21.12), and still needs the volume.
      if (signals.conversions_30d === null || signals.conversions_30d < PMAX_MIN_CONVERSIONS_30D) {
        typeChange(
          'pmax_low_volume',
          'SEARCH',
          'حوّلنا الحملة من أداء أقصى لحملة بحث. أداء أقصى يبدأ بعد 30 تحويل في الشهر، وتحت هالحجم البحث أضبط وأرخص في التعلم.'
        );
      }
    } else if (objective === 'LEADS') {
      typeChange(
        'pmax_leads',
        'SEARCH',
        'حوّلنا الحملة من أداء أقصى لحملة بحث. أداء أقصى لجمع العملاء المحتملين ما يشتغل بدون رفع نتائج المبيعات من عندك (أوفلاين)، وهذا مو متوفر حالياً.'
      );
    } else if (signals.merchant_center_linked !== true) {
      typeChange(
        'pmax_no_feed',
        'SEARCH',
        'حوّلنا الحملة من أداء أقصى لحملة بحث. أداء أقصى للمتاجر يحتاج Merchant Center مربوط بفيد سليم، وما قدرنا نتأكد منه في حسابك.'
      );
    } else if (signals.conversions_30d === null || signals.conversions_30d < PMAX_MIN_CONVERSIONS_30D) {
      typeChange(
        'pmax_low_volume',
        'SHOPPING',
        'حوّلنا الحملة من أداء أقصى لحملة تسوق. أداء أقصى يبدأ بعد 30 تحويل في الشهر مع فيد سليم، وتحت هالحجم التسوق أضبط وأرخص في التعلم.'
      );
    }
  }

  if (type === 'SHOPPING' && signals.merchant_center_linked !== true) {
    typeChange(
      'shopping_no_feed',
      'SEARCH',
      'حوّلنا الحملة لحملة بحث، لأن حملة التسوق تحتاج Merchant Center مربوط بفيد منتجات سليم وما قدرنا نتأكد منه في حسابك.'
    );
  }
  draft.type = type;

  // ---- Bidding ladder ------------------------------------------------------
  const allowed = allowedStrategies(signals, objective);
  const requestedStrategy = normalizeStrategy(draft.bidding_strategy);
  const fallbackStrategy = defaultStrategy(signals);
  let strategy: BuilderBidStrategy;
  if (requestedStrategy && allowed.includes(requestedStrategy)) {
    strategy = requestedStrategy;
  } else {
    strategy = fallbackStrategy;
    changes.push({ rule: 'bidding', from: String(draft.bidding_strategy ?? ''), to: strategy });
    const why =
      requestedStrategy === 'TARGET_CPA' || requestedStrategy === 'TARGET_ROAS'
        ? 'ما قبلنا مزايدة الهدف لحملة جديدة. تحتاج 30 تحويل في آخر 30 يوم وتتبع سليم، وحسابك ما وصل. '
        : requestedStrategy === 'MAXIMIZE_CONVERSIONS'
          ? 'ما قبلنا تعظيم التحويلات، لأن ما قدرنا نتأكد إن التحويلات تتسجل صح في حسابك. '
          : '';
    notes.push(`${why}${strategyNoteAr(strategy)}`);
  }
  draft.bidding_strategy = strategy;
  draft.bidding_note_ar = strategyNoteAr(strategy);

  // A numeric target never comes from the builder (titan red rule 2).
  for (const key of Object.keys(draft)) {
    if (/^(target_cpa|target_roas|tcpa|troas)/i.test(key)) delete draft[key];
  }
  if (strategy === 'TARGET_CPA' || strategy === 'TARGET_ROAS') {
    draft.target_value_sar = null;
    missing.push(
      strategy === 'TARGET_CPA'
        ? 'قيمة تكلفة التحويل المستهدفة، من هامشك ونسبة إغلاقك'
        : 'قيمة العائد المستهدف، من هامشك'
    );
  }

  if (strategy === 'MAXIMIZE_CLICKS' || strategy === 'MANUAL_CPC') {
    const cap = finiteOrNull(draft.max_cpc_sar);
    if (cap === null || cap <= 0) {
      draft.max_cpc_sar = null;
      missing.push('سقف سعر النقرة (لا يزيد عن عُشر الميزانية اليومية)');
      changes.push({ rule: 'cpc_cap_missing' });
      notes.push('حدد سقف سعر النقرة قبل ما تفعّل الحملة. بدونه تعظيم النقرات يدفع أي سعر.');
    } else {
      draft.max_cpc_sar = cap;
      const budget = finiteOrNull(draft.daily_budget_sar);
      if (budget !== null && budget > 0 && cap > budget / CPC_CAP_BUDGET_DIVISOR) {
        changes.push({ rule: 'cpc_cap_high' });
        notes.push('سقف سعر النقرة أعلى من عُشر الميزانية اليومية، يعني ميزانيتك تجيب أقل من 10 نقرات باليوم وما يتعلم منها شي.');
      }
    }
  } else {
    delete draft.max_cpc_sar;
  }

  // ---- Keyword match types ------------------------------------------------
  const broadAllowed =
    (strategy === 'TARGET_CPA' || strategy === 'TARGET_ROAS') &&
    (signals.conversions_30d ?? 0) >= BROAD_MIN_CONVERSIONS_30D;
  let downgradedBroad = 0;
  if (Array.isArray(draft.ad_groups)) {
    for (const group of draft.ad_groups) {
      const groupRecord = asRecord(group);
      if (!groupRecord || !Array.isArray(groupRecord.keywords)) continue;
      groupRecord.keywords = groupRecord.keywords.map((keyword: unknown) => {
        const entry = typeof keyword === 'string' ? { text: keyword } : asRecord(keyword);
        if (!entry) return keyword;
        const matchType = String(entry.match_type ?? '').trim().toUpperCase();
        if (matchType === 'EXACT' || matchType === 'PHRASE') return { ...entry, match_type: matchType };
        if (matchType === 'BROAD' && broadAllowed) return { ...entry, match_type: 'BROAD' };
        if (matchType === 'BROAD') downgradedBroad += 1;
        return { ...entry, match_type: 'PHRASE' };
      });
    }
  }
  if (downgradedBroad > 0) {
    changes.push({ rule: 'broad_match', from: 'BROAD', to: 'PHRASE' });
    notes.push('حوّلنا الكلمات الواسعة (Broad) لمطابقة العبارة (Phrase). الواسعة تحتاج مزايدة بهدف و30 تحويل في الشهر، وإلا تصرف على بحث ما يخصك.');
  }

  // ---- Settings -----------------------------------------------------------
  if (type === 'SEARCH') {
    draft.network_settings = { search_partners: false, display_network: false };
  }

  const locationReason = typeof draft.location_option_reason_ar === 'string' ? draft.location_option_reason_ar.trim() : '';
  if (String(draft.location_option ?? '').toUpperCase() === 'PRESENCE_OR_INTEREST' && locationReason) {
    draft.location_option = 'PRESENCE_OR_INTEREST';
  } else {
    if (draft.location_option && String(draft.location_option).toUpperCase() !== 'PRESENCE') {
      changes.push({ rule: 'location_option', from: String(draft.location_option), to: 'PRESENCE' });
    }
    draft.location_option = 'PRESENCE';
    delete draft.location_option_reason_ar;
  }

  draft.status = 'PAUSED';
  draft.approval_required = true;

  // ---- No invented numbers ------------------------------------------------
  draft.forecast = forecastUnavailable();

  // ---- No guarantee wording -----------------------------------------------
  // A guarantee the merchant wrote in the brief is theirs to make; one the
  // model added is an unverified promise.
  if (!mentionsGuarantee(brief) && Array.isArray(draft.ad_groups)) {
    let removed = 0;
    for (const group of draft.ad_groups) {
      const groupRecord = asRecord(group);
      if (!groupRecord) continue;
      for (const field of ['headlines_ar', 'descriptions_ar']) {
        if (!Array.isArray(groupRecord[field])) continue;
        const kept = groupRecord[field].filter((line: unknown) => typeof line !== 'string' || !mentionsGuarantee(line));
        removed += groupRecord[field].length - kept.length;
        groupRecord[field] = kept;
      }
    }
    if (removed > 0) {
      changes.push({ rule: 'guarantee_copy' });
      notes.push('شلنا من نص الإعلان أي عبارة تعد بنتيجة، لأننا ما نقدر نثبتها. اكتب بدالها عناوين تقدر تثبتها.');
    }
  }

  if (missing.length > 0) draft.missing_inputs_ar = Array.from(new Set(missing));
  draft.gate_notes_ar = notes;

  return { draft, notes_ar: notes, changes };
}
