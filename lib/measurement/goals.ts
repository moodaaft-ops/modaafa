/**
 * Conversion goals and enhanced conversions review (item 5 of the measurement
 * plan). Reads what the account is counting as a conversion and says, in
 * Saudi Arabic, what looks wrong and what to do. Pure: the tool feeds it rows.
 *
 * It never changes anything. The only changes it can lead to are the approval
 * cards (create the lead action, make it primary), each built elsewhere.
 */
export const LEAD_CONVERSION_ACTION_NAME = 'مُضاعِف | زبون فعلي';
/** The uploaded action needs this many conversions in 30 days before we recommend it as primary (titan: 15 or more per 30 days for a lead goal). */
export const LEAD_ACTION_PRIMARY_MIN_30D = 15;

export type GoalActionInfo = {
  name: string;
  resourceName?: string;
  status: string;
  type: string;
  category: string;
  origin?: string;
  primaryForGoal: boolean | null;
  includeInConversionsMetric: boolean | null;
  /** all_conversions over the last 30 days. null when the daily check was unavailable. */
  conversions30d: number | null;
};

export type CustomerGoalInfo = { category: string; origin: string; biddable: boolean | null };

export type ConversionTrackingInfo = {
  /** conversion_tracking_setting.enhanced_conversions_for_leads_enabled; null when not readable. */
  enhancedConversionsForLeads: boolean | null;
  /** conversion_tracking_setting.accepted_customer_data_terms; null when not readable. */
  acceptedCustomerDataTerms: boolean | null;
};

export type GoalFindingCode =
  | 'multiple_primaries_same_category'
  | 'whatsapp_click_primary'
  | 'call_click_primary'
  | 'primary_not_biddable'
  | 'enhanced_conversions_off'
  | 'customer_data_terms_not_accepted'
  | 'enhanced_conversions_unreadable'
  | 'lead_action_missing'
  | 'lead_action_ready_for_primary';

export type GoalFinding = {
  code: GoalFindingCode;
  severity: 'high' | 'medium' | 'info';
  title_ar: string;
  reason_ar: string;
  steps_ar: string[];
  actions?: string[];
};

export type GoalsReviewInput = {
  actions: GoalActionInfo[];
  goals: CustomerGoalInfo[] | null;
  tracking: ConversionTrackingInfo | null;
  /** True when LEAD_LOOP_ENABLED: only then do we talk about the uploaded action. */
  leadLoopOn: boolean;
};

const WHATSAPP_NAME = /whats\s?app|واتس\s?اب|واتساب|wa\.me|ماسنجر/i;
const CALL_TYPES = new Set(['CLICK_TO_CALL', 'AD_CALL', 'WEBSITE_CALL']);
/** Website tag sources that count the same visitor action when two of them are primary. */
const FAMILY: Record<string, string> = {
  WEBPAGE: 'google_tag',
  WEBPAGE_CODELESS: 'google_tag',
  GOOGLE_ANALYTICS_4_PURCHASE: 'ga4_import',
  GOOGLE_ANALYTICS_4_CUSTOM: 'ga4_import',
  UNIVERSAL_ANALYTICS_GOAL: 'ga4_import',
  UNIVERSAL_ANALYTICS_TRANSACTION: 'ga4_import',
  FIREBASE_ANDROID_CUSTOM: 'app',
  FIREBASE_IOS_CUSTOM: 'app',
  THIRD_PARTY_APP_ANALYTICS_ANDROID_CUSTOM: 'app',
  THIRD_PARTY_APP_ANALYTICS_IOS_CUSTOM: 'app',
};

function isPrimary(action: GoalActionInfo) {
  return action.status === 'ENABLED' && (action.primaryForGoal === true || action.includeInConversionsMetric === true);
}

export function isWhatsappClickAction(action: GoalActionInfo) {
  return WHATSAPP_NAME.test(action.name) && action.type !== 'UPLOAD_CLICKS';
}

function list(names: string[]) {
  const shown = names.slice(0, 3).map((name) => `"${name.replace(/["\n\r]/g, ' ').trim().slice(0, 60)}"`);
  return names.length > 3 ? `${shown.join('، ')} و${names.length - 3} غيرها` : shown.join('، ');
}

export function isLeadAction(action: Pick<GoalActionInfo, 'name' | 'type'>) {
  return action.type === 'UPLOAD_CLICKS' && action.name === LEAD_CONVERSION_ACTION_NAME;
}

export function reviewConversionGoals(input: GoalsReviewInput): GoalFinding[] {
  const findings: GoalFinding[] = [];
  const enabled = input.actions.filter((action) => action.status === 'ENABLED');
  const primaries = enabled.filter(isPrimary);

  // 1. Two primaries that count the same thing.
  const byCategory = new Map<string, GoalActionInfo[]>();
  for (const action of primaries) {
    // Uploaded and call-from-ads actions measure different events by design.
    if (action.type === 'UPLOAD_CLICKS' || CALL_TYPES.has(action.type)) continue;
    const key = `${action.category}|${action.origin ?? 'WEBSITE'}`;
    byCategory.set(key, [...(byCategory.get(key) ?? []), action]);
  }
  for (const [, group] of byCategory) {
    if (group.length < 2) continue;
    const families = new Set(group.map((action) => FAMILY[action.type] ?? action.type));
    const mixed = families.size > 1;
    const names = group.map((action) => action.name);
    findings.push({
      code: 'multiple_primaries_same_category',
      severity: mixed ? 'high' : 'medium',
      title_ar: 'أكثر من تحويل أساسي يعدّ نفس الشي',
      reason_ar: mixed
        ? `عندك ${group.length} تحويلات أساسية بنفس النوع من مصدرين مختلفين (${list(names)})، والغالب إنهم يعدّون نفس العملية مرتين ويكذبون على المزايدة`
        : `عندك ${group.length} تحويلات أساسية بنفس النوع (${list(names)})، وإذا كانوا يعدّون نفس العملية فالمزايدة تشوف أرقام مضاعفة`,
      steps_ar: [
        'افتح قوقل أدس ثم الأهداف ثم الملخص وشوف قائمة التحويلات',
        'اختار تحويل واحد يمثل العملية الحقيقية وخله أساسي',
        'الباقي حوله إلى ثانوي (Secondary) من إعدادات كل تحويل',
        'لا تغير شي لو كل تحويل يعدّ خطوة مختلفة فعلاً (مثل إضافة للسلة وشراء)',
      ],
      actions: names.map((name) => name.slice(0, 80)),
    });
  }

  // 2. WhatsApp click counted as the primary result.
  const whatsapp = primaries.filter(isWhatsappClickAction);
  if (whatsapp.length > 0) {
    const names = whatsapp.map((action) => action.name);
    const lead = input.actions.find(isLeadAction);
    const leadReady = lead ? (lead.conversions30d ?? 0) >= LEAD_ACTION_PRIMARY_MIN_30D : false;
    const steps = [
      'نقرة زر الواتساب تقيس النية مو الزبون، وكل من ضغط يتحسب حتى لو ما ردّ',
      'خلّها ثانوية (Secondary) أول ما يكون عندك تحويل أعمق منها',
    ];
    if (input.leadLoopOn) {
      steps.push(
        leadReady
          ? `تحويل "${LEAD_CONVERSION_ACTION_NAME}" وصل ${Math.round(lead!.conversions30d ?? 0)} في آخر 30 يوم، فصار يصلح أساسي`
          : `استخدم رابط الواتساب الذكي وعلّم الليدز في "ليدز هالأسبوع"، ولما يوصل "${LEAD_CONVERSION_ACTION_NAME}" إلى ${LEAD_ACTION_PRIMARY_MIN_30D} في 30 يوم نرشحه أساسي`
      );
    }
    findings.push({
      code: 'whatsapp_click_primary',
      severity: 'medium',
      title_ar: 'نقرة الواتساب محسوبة كنتيجة أساسية',
      reason_ar: `نقرة الواتساب (${list(names)}) هي التحويل الأساسي. هذي نية مو زبون فعلي، والمزايدة الذكية تتعلم تجيب ناس تضغط أكثر مو ناس تشتري`,
      steps_ar: steps,
      actions: names.map((name) => name.slice(0, 80)),
    });
  }

  // 3. Click on a call button counted as primary (Google forwarding numbers are not available in Saudi).
  const calls = primaries.filter((action) => CALL_TYPES.has(action.type));
  if (calls.length > 0) {
    findings.push({
      code: 'call_click_primary',
      severity: 'medium',
      title_ar: 'نقرة زر الاتصال محسوبة كتحويل أساسي',
      reason_ar: `${list(calls.map((action) => action.name))} يسجّل ضغطة على زر الاتصال، وأرقام التحويل من قوقل غير متوفرة في السعودية فما نعرف إذا تمت مكالمة أصلاً`,
      steps_ar: [
        'خلّه ثانوي (Secondary) أو بقيمة أقل',
        'خل الأساسي أعمق نتيجة تقدر تقيسها فعلاً',
      ],
      actions: calls.map((action) => action.name.slice(0, 80)),
    });
  }

  // 4. Primary inside a goal category that is not biddable: no campaign learns from it.
  if (input.goals) {
    const notBiddable = new Set(
      input.goals.filter((goal) => goal.biddable === false).map((goal) => `${goal.category}|${goal.origin}`)
    );
    const stuck = primaries.filter((action) => notBiddable.has(`${action.category}|${action.origin ?? 'WEBSITE'}`));
    if (stuck.length > 0) {
      findings.push({
        code: 'primary_not_biddable',
        severity: 'high',
        title_ar: 'تحويل أساسي داخل هدف مستبعد من المزايدة',
        reason_ar: `التحويلات ${list(stuck.map((action) => action.name))} أساسية، لكن هدفها مقفول عن المزايدة، فما فيه حملة تتعلم منها`,
        steps_ar: [
          'افتح قوقل أدس ثم الأهداف ثم الملخص',
          'اختار الهدف المقصود وفعّل "استخدام في المزايدة" أو حوّل التحويل إلى ثانوي لو مو مقصود',
        ],
        actions: stuck.map((action) => action.name.slice(0, 80)),
      });
    }
  }

  // 5. Enhanced conversions. The API exposes the leads switch and the data terms; the web switch is not readable.
  const tracking = input.tracking;
  if (!tracking || (tracking.enhancedConversionsForLeads === null && tracking.acceptedCustomerDataTerms === null)) {
    findings.push({
      code: 'enhanced_conversions_unreadable',
      severity: 'info',
      title_ar: 'ما قدرنا نقرا حالة التحويلات المحسّنة',
      reason_ar: 'الـAPI ما رجّع حالة التحويلات المحسّنة لهذا الحساب. لازم تتأكد منها بنفسك من الإعدادات',
      steps_ar: [
        'افتح قوقل أدس ثم الأهداف ثم الإعدادات',
        'افتح "استخدام بيانات العميل" وتأكد إن التحويلات المحسّنة مفعّلة وإنك قبلت شروط معالجة البيانات',
      ],
    });
  } else {
    if (tracking.acceptedCustomerDataTerms === false) {
      findings.push({
        code: 'customer_data_terms_not_accepted',
        severity: 'high',
        title_ar: 'شروط بيانات العميل ما انقبلت',
        reason_ar: 'شروط معالجة بيانات العميل ما انقبلت في الحساب، وبدونها ترفض قوقل التحويلات المحسّنة ورفع التحويلات اللي فيها بيانات شخصية',
        steps_ar: [
          'افتح قوقل أدس ثم الأهداف ثم الإعدادات ثم استخدام بيانات العميل',
          'اقرا الشروط واقبلها (القبول لازم يكون من صاحب الحساب)',
        ],
      });
    }
    if (tracking.enhancedConversionsForLeads === false) {
      findings.push({
        code: 'enhanced_conversions_off',
        severity: 'medium',
        title_ar: 'التحويلات المحسّنة للليدز مقفولة',
        reason_ar: 'التحويلات المحسّنة للليدز مقفولة. تفعيلها يرفع نسبة ربط الزبون بالإعلان خصوصاً لما تضيع الكوكيز',
        steps_ar: [
          'افتح قوقل أدس ثم الأهداف ثم الإعدادات ثم استخدام بيانات العميل',
          'فعّل التحويلات المحسّنة وقبول الشروط',
          'حالة التحويلات المحسّنة للويب ما تنقرا من الـAPI، تأكد منها من نفس الصفحة',
        ],
      });
    }
  }

  // 6. The uploaded lead action.
  if (input.leadLoopOn) {
    const lead = input.actions.find(isLeadAction);
    if (!lead || lead.status !== 'ENABLED') {
      findings.push({
        code: 'lead_action_missing',
        severity: 'info',
        title_ar: `تحويل "${LEAD_CONVERSION_ACTION_NAME}" مو موجود`,
        reason_ar: 'عشان نرفع الزبائن الفعليين لقوقل نحتاج تحويل من نوع رفع نقرات. ننشئه بعد موافقتك وما يغيّر شي في المزايدة لأنه ينشأ ثانوي',
        steps_ar: ['اضغط "اعتمد" على بطاقة إنشاء التحويل في مركز الموافقات', 'انتظر 6 ساعات قبل أول رفع، هذي مدة قوقل'],
      });
    } else if (!isPrimary(lead) && (lead.conversions30d ?? 0) >= LEAD_ACTION_PRIMARY_MIN_30D) {
      findings.push({
        code: 'lead_action_ready_for_primary',
        severity: 'medium',
        title_ar: 'الزبون الفعلي صار يصلح تحويل أساسي',
        reason_ar: `"${LEAD_CONVERSION_ACTION_NAME}" سجّل ${Math.round(lead.conversions30d ?? 0)} تحويل في آخر 30 يوم، وهذا يكفي للمزايدة تتعلم منه بدل نقرة الواتساب`,
        steps_ar: [
          'اعتمد بطاقة "اجعل الزبون الفعلي تحويلاً أساسياً" في مركز الموافقات',
          'البطاقة تحوّل نقرة الواتساب إلى ثانوي في نفس الخطوة، وتقدر تتراجع عنها',
          'لا تغيّر الميزانية أو الهدف في نفس الأسبوع، خل المزايدة تستقر',
        ],
      });
    }
  }

  return findings;
}
