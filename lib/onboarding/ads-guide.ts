/**
 * Content and rules for the "ما عندي حساب إعلانات" guide.
 *
 * Opening a Google Ads account is the customer's own action: this guide only
 * explains it. Nothing here creates an account or touches billing for anyone.
 */

export const ADS_SIGNUP_URL = 'https://ads.google.com/home/';

export type GuideStep = { title: string; body: string };

export const GUIDE_STEPS: GuideStep[] = [
  {
    title: 'افتح Google Ads بالبريد الصحيح',
    body: 'ادخل على ads.google.com من نفس متصفحك وسجّل بالبريد اللي تبغاه يملك الحساب. هذا نفس البريد اللي بتختاره لاحقاً في شاشة الربط.',
  },
  {
    title: 'تخطَّ إنشاء الحملة',
    body: 'إذا بدأ Google يقترح عليك حملة، اختر «التبديل إلى وضع الخبير» ثم «إنشاء حساب بدون حملة». الحساب يكفي الحين، والحملات تجي بعده.',
  },
  {
    title: 'ثبّت البلد والعملة والمنطقة الزمنية',
    body: 'اختر السعودية والريال والتوقيت المحلي. Google ما تسمح بتغيير العملة والمنطقة الزمنية بعد الإنشاء، فاختارها صح من أول مرة.',
  },
  {
    title: 'وسيلة الدفع عند Google، وقت تشغيل الإعلان',
    body: 'Google تطلب بطاقتك أنت قبل ما يشتغل أي إعلان، وهذا يصير عندها وليس عندنا. إن أجّلت هذي الخطوة يبقى الحساب مفتوحاً وتقدر تربطه.',
  },
  {
    title: 'ارجع هنا واربط الحساب',
    body: 'بعد ما يظهر لك الحساب داخل Google Ads، اضغط «فتحت الحساب» وكمّل الربط بنفس البريد.',
  },
];

export const GUIDE_LIMIT_NOTE =
  'حد صريح: حساب جديد بدون حملات ما عنده بيانات نقرأها، فالفحص الأول يطلع قصير. الفحص يفيدك أكثر لما تكون عندك حملات تشتغل.';

export type GuideVideo = { id: string; title: string; embedUrl: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The embedded explainer is configured, not hard-coded: the id comes from
 * NEXT_PUBLIC_ADS_GUIDE_VIDEO_ID so the team can swap it without a deploy of
 * code, and a missing or malformed id simply hides the video. The written steps
 * above always stand alone. No autoplay, and the privacy-enhanced host is used.
 */
export function resolveGuideVideo(
  id: string | undefined | null,
  title = 'شرح فتح حساب Google Ads'
): GuideVideo | null {
  const clean = (id ?? '').trim();
  if (!VIDEO_ID.test(clean)) return null;
  return {
    id: clean,
    title,
    embedUrl: `https://www.youtube-nocookie.com/embed/${clean}?autoplay=0&rel=0&modestbranding=1`,
  };
}

/** Where the connect step sends someone who has no ads account. */
export const NO_ACCOUNT_PATH = '/onboarding/ads-guide';
