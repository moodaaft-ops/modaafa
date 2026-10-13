/**
 * Who may be messaged on WhatsApp.
 *
 * Meta requires a clear opt-in before a business sends anything, and a
 * business that keeps messaging people who said stop gets its number rated
 * down fast. So the rule is two timestamps and nothing implicit:
 *   - whatsapp_opt_in_at is set by an explicit action (a checkbox at sign-up).
 *   - whatsapp_opt_out_at is set when the user replies with a stop word.
 * An opt-out holds until the user opts in again: the opt-in has to be newer
 * than the last opt-out, otherwise the answer stays no.
 */
export type WhatsAppConsent = {
  whatsapp_opt_in_at?: string | null;
  whatsapp_opt_out_at?: string | null;
};

export function canSendWhatsApp(user: WhatsAppConsent): boolean {
  const optIn = parse(user.whatsapp_opt_in_at);
  if (optIn === null) return false;
  const optOut = parse(user.whatsapp_opt_out_at);
  if (optOut === null) return true;
  return optIn > optOut;
}

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * A reply that means "stop messaging me". Exact match only: a sentence like
 * "ما ابي اوقف الاشتراك" must not unsubscribe anyone by accident.
 */
const STOP_WORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'ايقاف',
  'وقف',
  'الغاء',
  'الغاء الاشتراك',
  'ايقاف الاشتراك',
]);

export function isStopMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text
    .toLowerCase()
    .replace(/[ً-ٟـ]/g, '') // tashkeel and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/[.!؟?،,]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return STOP_WORDS.has(normalized);
}
