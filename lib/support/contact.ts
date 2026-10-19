/**
 * Human help on WhatsApp for people who signed up but have no Google Ads
 * account to connect.
 *
 * Google answers `NOT_ADS_USER` when the Google account the user picks on the
 * consent screen owns no Google Ads account. On 1 Oct 2026 that hit 13
 * different users in one day, most of them first-time advertisers arriving
 * from TikTok who don't know what a Google Ads account is. The recovery block
 * on /onboarding/connect explains the two self-serve fixes and offers this
 * chat as the third: Modaafa opens the account with them, free.
 *
 * The prefilled message carries the user's Modaafa email so the first
 * message already says who is asking.
 */
export const SUPPORT_WHATSAPP_NUMBER = '966541004029';

/** Same number, written the way Saudi users read it. */
export const SUPPORT_WHATSAPP_DISPLAY = '054 100 4029';

export type WhatsAppHelpReason = 'no_ads_account' | 'manager_only' | 'connect_failed' | 'full_management';

const OPENERS: Record<WhatsAppHelpReason, string> = {
  no_ads_account: 'سجلت في مضاعف وما عندي حساب اعلانات قوقل، ابي مساعدة افتحه',
  manager_only: 'سجلت في مضاعف وعندي حساب اداري MCC بس بدون حساب اعلاني تحته، ابي مساعدة',
  connect_failed: 'سجلت في مضاعف وما قدرت اربط حساب اعلانات قوقل، ابي مساعدة',
  // The agency ending of the adaptive onboarding: someone already has an account and wants Modaafa's team to run it.
  full_management: 'سجلت في مضاعف وابي فريق مضاعفة يدير حساب اعلاناتي',
};

/**
 * The WhatsApp link the support bot offers once it cannot finish the job. The
 * prefilled text carries the bot's own two-line summary of the question, so
 * the person answering does not have to ask it again. Everything is cleaned
 * here because the summary comes from a model and the page path from a browser.
 */
export function supportBotHandoffUrl({
  summary,
  email,
  page,
}: {
  summary?: string | null;
  email?: string | null;
  page?: string | null;
}) {
  const lines = ['السلام عليكم', 'كنت أكلم الدعم في مضاعف وما انحلت مشكلتي'];
  const cleanSummary = cleanLine(summary, 300);
  if (cleanSummary) lines.push(`سؤالي: ${cleanSummary}`);
  const cleanEmail = cleanLine(email, 120);
  if (cleanEmail) lines.push(`ايميلي في المنصة: ${cleanEmail}`);
  const cleanPage = cleanLine(page, 80);
  if (cleanPage && /^\/[A-Za-z0-9\-_/]*$/.test(cleanPage)) lines.push(`الصفحة: ${cleanPage}`);
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}

function cleanLine(value: string | null | undefined, max: number) {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function whatsappHelpUrl(reason: WhatsAppHelpReason, email?: string | null) {
  const lines = ['السلام عليكم', OPENERS[reason]];
  const cleanEmail = email?.trim();
  if (cleanEmail) lines.push(`ايميلي في المنصة: ${cleanEmail}`);
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}
