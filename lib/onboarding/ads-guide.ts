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

export type GuideVideoSegment = { start: number; end: number };

export type GuideVideo = {
  id: string;
  title: string;
  embedUrl: string;
  segment: GuideVideoSegment;
};

/**
 * Only videos a person on the team has reviewed may be embedded, and each one
 * carries its own cut. Any other id fails closed: the video is hidden and the
 * written steps stand alone. An unreviewed id must never inherit the timestamps
 * of a different video.
 *
 * G9tynCxUlg4: the account-opening part only, 1:16 to 2:05. The same video goes
 * on to build a campaign from 2:20, which a new customer should not follow. The
 * numbers come from the owner's review of the transcript. Whether the on-screen
 * Google UI still matches today's screens is reviewed by a person before the
 * env variable is turned on.
 */
export const REVIEWED_GUIDE_VIDEOS: Readonly<Record<string, GuideVideoSegment>> = {
  G9tynCxUlg4: { start: 76, end: 125 },
};

/** Shown on the guide page and again under the video. */
export const GUIDE_REGION_NOTICE =
  'اختر البلد والتوقيت والعملة حسب نشاط عملك. لو تبيع داخل السعودية، فاختر السعودية وتوقيت الرياض والريال السعودي. العملة والتوقيت ما يتغيّرون بعد إنشاء الحساب، فراجعهم قبل الإرسال.';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The embedded explainer is configured, not hard-coded: the id comes from
 * NEXT_PUBLIC_ADS_GUIDE_VIDEO_ID. A missing, malformed or unreviewed id hides
 * the video. The written steps above always stand alone. No autoplay, the
 * privacy-enhanced host is used, and the player keeps its normal controls and
 * keyboard so the customer can pause, replay a step and change the volume. The
 * end parameter stops playback; it does not stop someone from seeking on.
 */
export function resolveGuideVideo(
  id: string | undefined | null,
  title = 'شرح فتح حساب Google Ads'
): GuideVideo | null {
  const clean = (id ?? '').trim();
  if (!VIDEO_ID.test(clean)) return null;
  if (!Object.prototype.hasOwnProperty.call(REVIEWED_GUIDE_VIDEOS, clean)) return null;
  const segment = REVIEWED_GUIDE_VIDEOS[clean];
  const params = [
    'autoplay=0',
    'rel=0',
    'modestbranding=1',
    'playsinline=1',
    `start=${segment.start}`,
    `end=${segment.end}`,
  ];
  return {
    id: clean,
    title,
    embedUrl: `https://www.youtube-nocookie.com/embed/${clean}?${params.join('&')}`,
    segment,
  };
}

/** Where the connect step sends someone who has no ads account. */
export const NO_ACCOUNT_PATH = '/onboarding/ads-guide';
