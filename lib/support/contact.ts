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

export type WhatsAppHelpReason = 'no_ads_account' | 'manager_only' | 'connect_failed';

const OPENERS: Record<WhatsAppHelpReason, string> = {
  no_ads_account: 'سجلت في مضاعف وما عندي حساب اعلانات قوقل، ابي مساعدة افتحه',
  manager_only: 'سجلت في مضاعف وعندي حساب اداري MCC بس بدون حساب اعلاني تحته، ابي مساعدة',
  connect_failed: 'سجلت في مضاعف وما قدرت اربط حساب اعلانات قوقل، ابي مساعدة',
};

export function whatsappHelpUrl(reason: WhatsAppHelpReason, email?: string | null) {
  const lines = ['السلام عليكم', OPENERS[reason]];
  const cleanEmail = email?.trim();
  if (cleanEmail) lines.push(`ايميلي في المنصة: ${cleanEmail}`);
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}
