/**
 * The immediate email a visitor gets after leaving their address in the
 * landing page's exit popup.
 *
 * `approved` is false on purpose. Nothing is emailed to a lead until Ayman has
 * read this text and flipped it to true. Leads are still saved while it is
 * false and show up in /operations as "waiting for the text to be approved".
 *
 * The sample-report link is not written here: it comes from
 * lib/growth/owner-config.ts, so the email can never point at a report that
 * does not exist.
 */

export const LEAD_FOLLOWUP = {
  approved: false,
  subject: 'نموذج تقرير الفحص اللي طلبته من مُضاعِف',
  // {report} is replaced with the sample-report link, {start} with the sign-in link.
  intro: 'هلا، هذا نموذج تقرير فحص من مُضاعِف:',
  reportLabel: 'افتح نموذج التقرير',
  body: 'فيه كيف نرتب لك الصرف اللي ما جاب نتيجة بالريال، وأول خطوة تسويها.',
  limit: 'حد صريح: النموذج لحساب واحد، وتقرير حسابك يطلع له شكله الخاص.',
  startIntro: 'تبي تشوفه على حسابك أنت؟ أول فحص مجاني وبدون بطاقة:',
  startLabel: 'افحص حسابي',
  reply: 'لو عندك سؤال رد على هذا الإيميل.',

  // WhatsApp is never sent by the server. /operations shows this as a ready
  // message Ayman can edit and send himself. The sample link goes on a new line.
  whatsappText: 'هلا، أنا أيمن من مُضاعِف. طلبت نموذج تقرير الفحص، هذا هو:',
} as const;
