/**
 * Rule-based detectors for the problem that sits OUTSIDE the ad account: the
 * ad does its job (people click, people message on WhatsApp) and the money is
 * lost after that, in the offer, the price or how fast the merchant answers.
 *
 * A model is never asked. The numbers are the merchant's own and the words say
 * "غالباً": these are inferences from rates, not proof, and they say so. Bounce
 * and session data are not available to us, so the second detector compares the
 * conversion rate with the account's own history instead.
 */

/** A search ad with a CTR at or above this is doing its job (used only when no sector median is known). */
export const GOOD_CTR_FLOOR = 0.05;
/** Enough WhatsApp clicks and enough verdicts from the merchant before we say anything. */
export const MIN_WHATSAPP_CLICKS = 20;
export const MIN_MARKED_LEADS = 10;
/** Of the leads the merchant marked, under this share became customers. */
export const LOW_CUSTOMER_RATE = 0.1;
/** Of the leads marked, this share or more were «مو جاد»: the traffic is the problem, not the offer. */
export const NOT_SERIOUS_SHARE_LIMIT = 0.4;
/** Of the leads marked, this share or more did not answer. */
export const NO_REPLY_SHARE_LIMIT = 0.3;
/** Conversion rate fell by at least this share against the account's own earlier rate. */
export const CONVERSION_RATE_DROP = 0.4;
export const MIN_CURRENT_CLICKS = 150;
export const MIN_HISTORY_CLICKS = 200;
export const MIN_HISTORY_CONVERSIONS = 20;
/** CTR within this share of the earlier CTR counts as «نفس الأول». */
export const CTR_STABLE_SHARE = 0.85;

export type LeadStats = {
  /** Smart link visits (clicks that reached WhatsApp) in the window. */
  total: number;
  /** Leads the merchant gave a verdict on. */
  marked: number;
  customers: number;
  notSerious: number;
  noReply: number;
};

export type CoachingInput = {
  windowDays: number;
  clicks: number;
  impressions: number;
  conversions: number;
  /** The same figures for an earlier window of the same account (for example days 31 to 120). null when unknown. */
  history: { clicks: number; impressions: number; conversions: number } | null;
  leads: LeadStats | null;
  /** Median CTR of the sector when we have one (lib/ai sector benchmarks). */
  sectorMedianCtr?: number | null;
};

export type CoachingInsightCode = 'offer_or_response' | 'traffic_quality' | 'conversion_rate_drop';

export type CoachingInsight = {
  code: CoachingInsightCode;
  /** Where the problem most likely sits. */
  where: 'outside_account' | 'inside_account';
  text_ar: string;
  step_ar: string;
  evidence: Record<string, number>;
};

function ratio(a: number, b: number) {
  return b > 0 ? a / b : null;
}

function pct(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

export function detectCoaching(input: CoachingInput): CoachingInsight[] {
  const out: CoachingInsight[] = [];
  const ctr = ratio(input.clicks, input.impressions);

  const leads = input.leads;
  if (leads && leads.total >= MIN_WHATSAPP_CLICKS && leads.marked >= MIN_MARKED_LEADS) {
    const customerRate = leads.customers / leads.marked;
    const notSeriousShare = leads.notSerious / leads.marked;
    const noReplyShare = leads.noReply / leads.marked;
    const goodCtr = ctr !== null && ctr >= (input.sectorMedianCtr && input.sectorMedianCtr > 0 ? input.sectorMedianCtr : GOOD_CTR_FLOOR);

    if (customerRate < LOW_CUSTOMER_RATE) {
      if (notSeriousShare >= NOT_SERIOUS_SHARE_LIMIT) {
        out.push({
          code: 'traffic_quality',
          where: 'inside_account',
          text_ar: `من ${leads.marked} علّمتهم، ${leads.notSerious} قلت إنهم مو جادين. هنا المشكلة غالباً في الناس اللي يجيها الإعلان مو في عرضك.`,
          step_ar: 'خلّ مُضاعِف يراجع مصطلحات البحث ويضيف سلبيات للكلمات اللي تجيب فضوليين، وكمّل تعليم الليدز عشان نعرف أي كلمة تجيب جادين.',
          evidence: { marked: leads.marked, notSerious: leads.notSerious, customers: leads.customers },
        });
      } else if (goodCtr) {
        const noReplyText =
          noReplyShare >= NO_REPLY_SHARE_LIMIT
            ? ` و${leads.noReply} منهم ما ردّوا علينا بعد ما كلمناهم، وهذا يدل غالباً على ردّ متأخر أو رسالة أولى ما شجّعت.`
            : '';
        out.push({
          code: 'offer_or_response',
          where: 'outside_account',
          text_ar: `إعلانك يشتغل: نسبة النقر ${pct(ctr as number)} وفيه ${leads.total} ضغطة واتساب. بس من ${leads.marked} علّمتهم صار زبون ${leads.customers} بس.${noReplyText} غالباً المشكلة برا الإعلان، في العرض أو السعر أو سرعة الرد، وهذا استنتاج من الأرقام مو متأكدين منه.`,
          step_ar:
            'جرّب هالأسبوع: رد على كل رسالة خلال دقايق، وأرسل السعر والعرض في أول رد بدل ما تنتظر يسألون. وبعد أسبوع شوف إذا تغيّرت نسبة اللي صاروا زبائن.',
          evidence: {
            ctrPct: Math.round((ctr as number) * 1000) / 10,
            whatsappClicks: leads.total,
            marked: leads.marked,
            customers: leads.customers,
            noReply: leads.noReply,
          },
        });
      }
    }
  }

  const history = input.history;
  if (history && history.clicks >= MIN_HISTORY_CLICKS && history.conversions >= MIN_HISTORY_CONVERSIONS && input.clicks >= MIN_CURRENT_CLICKS) {
    const crNow = input.conversions / input.clicks;
    const crBefore = history.conversions / history.clicks;
    const ctrBefore = ratio(history.clicks, history.impressions);
    const ctrStable = ctr !== null && ctrBefore !== null && ctr >= ctrBefore * CTR_STABLE_SHARE;
    if (crBefore > 0 && crNow <= crBefore * (1 - CONVERSION_RATE_DROP) && ctrStable) {
      out.push({
        code: 'conversion_rate_drop',
        where: 'outside_account',
        text_ar: `نسبة النقر ثابتة تقريباً بس التحويل نزل من ${pct(crBefore)} إلى ${pct(crNow)} من النقرات. لما النقر يثبت والتحويل ينزل، غالباً التغيير في صفحتك أو عرضك أو سعرك مو في الإعلان.`,
        step_ar: 'اسأل نفسك: غيّرت سعر أو عرض أو صفحة قريب؟ جرّب الصفحة وزر الواتساب من جوالك الحين، وشغّل فحص صفحة الهبوط.',
        evidence: {
          conversionRateNowPct: Math.round(crNow * 1000) / 10,
          conversionRateBeforePct: Math.round(crBefore * 1000) / 10,
          clicks: input.clicks,
        },
      });
    }
  }

  return out;
}

/** Lines for the monthly report: the same wording, one bullet each. Empty when nothing was found. */
export function coachingLinesForReport(insights: CoachingInsight[]): string[] {
  return insights.map((insight) => `${insight.text_ar} الخطوة: ${insight.step_ar}`);
}
