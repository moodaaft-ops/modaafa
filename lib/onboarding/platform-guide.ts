/**
 * The customer guide video: «دليل استخدام مُضاعِف», 3:58, on the agency's
 * YouTube channel. One video, nine chapters, nothing else may be embedded here.
 *
 * The id is fixed in code on purpose. It is the video the owner uploaded and
 * checked, so it does not come from an env variable or from a request. The
 * embed uses the privacy-enhanced host, the only one the Content-Security-Policy
 * allows (lib/security/csp.ts), and never autoplays before someone asks for it.
 *
 * The screens in the video come from a demo account. The player says so.
 */

export const PLATFORM_GUIDE_VIDEO_ID = '2fnPcMNSjvE';
export const PLATFORM_GUIDE_TITLE = 'دليل استخدام مُضاعِف';
export const PLATFORM_GUIDE_PATH = '/guide';
export const PLATFORM_GUIDE_DURATION_SECONDS = 238;
export const PLATFORM_GUIDE_COVER = '/guide/cover.png';
export const PLATFORM_GUIDE_NOTE =
  'الشاشات في الفيديو من حساب تجريبي، فأرقام حسابك بتختلف. وإذا علّقت في أي خطوة، كلّم فريقنا على الواتساب.';

export type PlatformGuideChapter = { id: string; title: string; start: number };

/** Same cut points as the chapters on YouTube (0:00, 0:17, 0:36 ...). Seconds, ascending. */
export const PLATFORM_GUIDE_CHAPTERS: readonly PlatformGuideChapter[] = [
  { id: 'intro', title: 'البداية', start: 0 },
  { id: 'what', title: 'وش هو مُضاعِف؟', start: 17 },
  { id: 'register', title: 'التسجيل', start: 36 },
  { id: 'connect', title: 'ربط حساب الإعلانات', start: 56 },
  { id: 'read', title: 'يقرا حسابك ويسألك', start: 83 },
  { id: 'plan', title: 'خطتك جاهزة', start: 107 },
  { id: 'daily', title: 'يومك مع مُضاعِف', start: 132 },
  { id: 'ask', title: 'اسأله بكلامك', start: 157 },
  { id: 'undo', title: 'تقدر ترجع', start: 173 },
  { id: 'faq', title: 'أسئلة توصلني كل يوم', start: 184 },
];

/** Where «وش يصير بعد ما أبدأ؟» lands: the chapter about the daily screen and the approve button. */
export const PLATFORM_GUIDE_AFTER_START_SECONDS = 132;

function cleanStart(start: number): number {
  if (!Number.isFinite(start)) return 0;
  return Math.min(Math.max(Math.floor(start), 0), PLATFORM_GUIDE_DURATION_SECONDS - 1);
}

export function platformGuideEmbedUrl({ start = 0, autoplay = false }: { start?: number; autoplay?: boolean } = {}): string {
  const params = [
    `autoplay=${autoplay ? 1 : 0}`,
    'rel=0',
    'modestbranding=1',
    'playsinline=1',
    'hl=ar',
    `start=${cleanStart(start)}`,
  ];
  return `https://www.youtube-nocookie.com/embed/${PLATFORM_GUIDE_VIDEO_ID}?${params.join('&')}`;
}

/** "2:12" for 132, for the chapter chips. */
export function formatGuideTime(seconds: number): string {
  const s = cleanStart(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
