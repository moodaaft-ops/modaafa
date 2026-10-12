/**
 * The "let Modaafa's team run it for you" offer.
 *
 * The same wording belongs on the landing page's two-paths section (brief item
 * 7). Keeping it in one file means the platform and the landing page cannot
 * drift apart: whichever chat builds the landing section imports from here.
 */

export const FULL_MANAGEMENT_URL = 'https://modaafa.com';

export const FULL_MANAGEMENT_COPY = {
  heading: 'الحساب يبغى متابعة يومية، وما كل واحد يفضى لها',
  body: 'الفحص يوريك وين تضيع الفلوس. وإذا ما عندك وقت تسويها بيدك، فريق مُضاعفة اللي يدير حسابات قوقل يومياً يتولاها عنك، وتتابع النتيجة من هنا.',
  button: 'خل فريق مضاعفة يديرها عنك',
  selfServe: 'وإذا تبي تسويها بنفسك، التوصيات فوق جاهزة.',
} as const;

/** Tagged so the agency can tell a click from the platform apart from the landing page. */
export function fullManagementHref(medium: 'audit_result' | 'landing' = 'audit_result') {
  const params = new URLSearchParams({ utm_source: 'platform', utm_medium: medium, utm_campaign: 'full_management' });
  return `${FULL_MANAGEMENT_URL}?${params.toString()}`;
}
