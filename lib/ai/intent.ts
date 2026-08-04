export type AssistantIntent =
  | 'budget'
  | 'why'
  | 'campaign_build'
  | 'recommendation'
  | 'keywords'
  | 'summary';

/** A question about an existing campaign must never create a campaign draft. */
const QUESTION_MARKERS =
  /^\s*(كيف|كم|ليش|لماذا|ما\b|ماذا|متى|وش|ايش|أيش|وين|أين|هل|من\b|أي\b|اي\b|what|how|why|when|which|where|who|is|are|do|does|can)\b|[؟?]\s*$/i;
const ANALYSIS_MARKERS =
  /حلل|تحليل|أداء|اداء|قارن|مقارنة|لخص|ملخص|اعرض|أعرض|راجع|report|analy[sz]e|compare|summar/i;

/** Bare "add" is excluded so adding a negative keyword is not a campaign build. */
const BUILD_MARKERS =
  /(ابن(ي|ِ)?|انشئ|أنشئ|سو(ي|ّي)?|اصنع|جهز|جهّز|اكتب لي|صمم|صمّم|create|build|launch|draft|new campaign|write me)/i;
const CAMPAIGN_OBJECT_MARKERS = /حمل(ة|ات|تي)|إعلان|اعلان|كامبين|campaign|ad\s|ads\b/i;
const KEYWORD_MARKERS = /كلمة|كلمات|keyword|negative|سلبية/i;

export function detectIntent(message: string): AssistantIntent {
  const looksLikeQuestion = QUESTION_MARKERS.test(message) || ANALYSIS_MARKERS.test(message);

  if (KEYWORD_MARKERS.test(message)) return 'keywords';

  if (BUILD_MARKERS.test(message) && CAMPAIGN_OBJECT_MARKERS.test(message) && !looksLikeQuestion) {
    return 'campaign_build';
  }

  if (/ميزاني|budget|صرف|انفاق|إنفاق|تكلفة|cpa|roas|عائد/i.test(message)) return 'budget';
  if (/ليش|لماذا|سبب|اشرح|فسر|explain|why/i.test(message)) return 'why';
  if (/توصي|توصية|افضل|أفضل|ابدأ|خطوة|قرار|حسن|تحسين|recommend/i.test(message)) {
    return 'recommendation';
  }
  return 'summary';
}
