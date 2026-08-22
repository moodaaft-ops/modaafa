export type AssistantIntent =
  | 'budget'
  | 'why'
  | 'campaign_build'
  | 'recommendation'
  | 'keywords'
  | 'performance'
  | 'comparison'
  | 'troubleshooting'
  | 'strategy'
  | 'report'
  | 'summary';

/** A question about an existing campaign must never create a campaign draft. */
const TOKEN_END = String.raw`(?=\s|$|[،,:؛؟?!])`;
const QUESTION_MARKERS =
  new RegExp(
    String.raw`^\s*(كيف|كم|ليش|لماذا|ما|ماذا|متى|وش|ايش|أيش|وين|أين|هل|من|أي|اي|what|how|why|when|which|where|who|is|are|do|does|can)${TOKEN_END}|[؟?]\s*$`,
    'i'
  );
const ANALYSIS_MARKERS =
  /حلل|تحليل|أداء|اداء|قارن|مقارنة|لخص|ملخص|اعرض|أعرض|راجع|report|analy[sz]e|compare|summar/i;

/** Bare "add" is excluded so adding a negative keyword is not a campaign build. */
const BUILD_MARKERS =
  /(ابن(ي|ِ)?|انشئ|أنشئ|سو(ي|ّي)?|اصنع|جهز|جهّز|اكتب لي|صمم|صمّم|create|build|launch|draft|new campaign|write me)/i;
const CAMPAIGN_OBJECT_MARKERS = /حمل(ة|ات|تي)|إعلان|اعلان|كامبين|campaign|ad\s|ads\b/i;
const KEYWORD_MARKERS = /كلمة|كلمات|keyword|negative|سلبية/i;
const REPORT_MARKERS = /تقرير|ملخص (?:أسبوعي|شهري)|weekly report|monthly report/i;
const COMPARISON_MARKERS = /قارن|مقارنة|مقابل|عن الأسبوع|عن الشهر|compare|versus|\bvs\b/i;
const PERFORMANCE_MARKERS = /حلل|تحليل|أداء|اداء|نتائج|تحويلات|نقرات|ظهور|ctr|performance|results/i;
const TROUBLESHOOTING_MARKERS = /مشكلة|ضعف|هبوط|انخفاض|تراجع|نازل|نازلة|قليل|قليلة|ارتفع|ارتفاع|diagnos|problem|declin/i;
const STRATEGY_MARKERS = /استراتيجي|استراتيجية|خطة|أولوية|أولويات|نمو|توسع|وسع|strategy|priorit|growth|scale/i;

export function detectIntent(message: string): AssistantIntent {
  const looksLikeQuestion = QUESTION_MARKERS.test(message) || ANALYSIS_MARKERS.test(message);

  if (KEYWORD_MARKERS.test(message)) return 'keywords';

  if (BUILD_MARKERS.test(message) && CAMPAIGN_OBJECT_MARKERS.test(message) && !looksLikeQuestion) {
    return 'campaign_build';
  }

  if (REPORT_MARKERS.test(message)) return 'report';
  if (COMPARISON_MARKERS.test(message)) return 'comparison';
  if (/ليش|لماذا|سبب|why/i.test(message) && PERFORMANCE_MARKERS.test(message)) return 'troubleshooting';
  if (TROUBLESHOOTING_MARKERS.test(message)) return 'troubleshooting';
  if (PERFORMANCE_MARKERS.test(message)) return 'performance';
  if (/ميزاني|budget|ارفع|رفع|خفض|قلل|صرف|انفاق|إنفاق|تكلفة|cpa|roas|عائد/i.test(message)) return 'budget';
  if (/ليش|لماذا|سبب|اشرح|فسر|explain|why/i.test(message)) return 'why';
  if (/توصي|توصية|افضل|أفضل|ابدأ|خطوة|قرار|حسن|تحسين|recommend/i.test(message)) {
    return 'recommendation';
  }
  if (STRATEGY_MARKERS.test(message)) return 'strategy';
  return 'summary';
}
