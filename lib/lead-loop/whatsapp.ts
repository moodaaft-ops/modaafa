/**
 * Merchant WhatsApp number and the prefilled message of the smart link.
 * Only mobile numbers are accepted for Saudi Arabia (WhatsApp chats run on
 * mobiles); other countries pass as plain international numbers.
 */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function toLatinDigits(value: string) {
  return value
    .replace(/[٠-٩]/g, (char) => String(ARABIC_DIGITS.indexOf(char)))
    .replace(/[۰-۹]/g, (char) => String(EASTERN_DIGITS.indexOf(char)));
}

export type WhatsappNumberResult =
  | { ok: true; number: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'not_mobile' };

/** Returns digits only, country code first, no plus sign: the shape wa.me wants. */
export function normalizeWhatsappNumber(input: unknown): WhatsappNumberResult {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'empty' };
  let digits = toLatinDigits(input).replace(/[\s().-]/g, '');
  if (/[^\d+]/.test(digits) || digits.indexOf('+') > 0 || digits.split('+').length > 2) {
    return { ok: false, reason: 'invalid' };
  }
  digits = digits.replace(/^\+/, '');
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Saudi shapes: 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, 966 05XXXXXXXX
  if (/^05\d{8}$/.test(digits)) digits = `966${digits.slice(1)}`;
  else if (/^5\d{8}$/.test(digits)) digits = `966${digits}`;
  else if (/^9660?5\d{8}$/.test(digits)) digits = `9665${digits.replace(/^9660?5/, '')}`;

  if (digits.startsWith('966')) {
    return /^9665\d{8}$/.test(digits) ? { ok: true, number: digits } : { ok: false, reason: 'not_mobile' };
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, reason: 'invalid' };
  return { ok: true, number: digits };
}

export const DEFAULT_WHATSAPP_TEXT = 'السلام عليكم، ابي استفسر';
export const MAX_WHATSAPP_TEXT = 300;

/** Strips control and bidi characters, keeps line breaks, caps the length. */
export function cleanWhatsappText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_WHATSAPP_TEXT);
}

/** The message the visitor sees prefilled: the merchant's text plus the reference line. */
export function composeWhatsappMessage(defaultText: string | null | undefined, refCode: string): string {
  const text = cleanWhatsappText(defaultText) || DEFAULT_WHATSAPP_TEXT;
  return `${text}\n\nرقم الطلب ${refCode}`;
}

export function buildWhatsappUrl(number: string, defaultText: string | null | undefined, refCode: string) {
  return `https://wa.me/${number}?text=${encodeURIComponent(composeWhatsappMessage(defaultText, refCode))}`;
}

/** Same link without a reference line, for visits that are not recorded. */
export function buildPlainWhatsappUrl(number: string, defaultText: string | null | undefined) {
  return `https://wa.me/${number}?text=${encodeURIComponent(cleanWhatsappText(defaultText) || DEFAULT_WHATSAPP_TEXT)}`;
}

export function publicLinkUrl(baseUrl: string, slug: string) {
  return `${baseUrl.replace(/\/+$/, '')}/w/${slug}`;
}

/**
 * Snippet the merchant pastes once in the site (before </body>). It keeps the
 * click ids of the Google ad in the browser for 90 days and appends them to
 * every link that points at the smart link, because the ids live on the
 * merchant's page URL and not on the link itself.
 */
export function buildLinkSnippet(baseUrl: string): string {
  const host = new URL(baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '');
  return [
    '<script>',
    '(function(){try{',
    'var K=["gclid","gbraid","wbraid","utm_source","utm_medium","utm_campaign","utm_content","utm_term"],S="mz_click",D=7776e6,q=new URLSearchParams(location.search),o={};',
    'try{o=JSON.parse(localStorage.getItem(S)||"{}");if(!o.t||Date.now()-o.t>D)o={}}catch(e){o={}}',
    'var n=0;K.forEach(function(k){var v=q.get(k);if(v){o[k]=v;n=1}});',
    'if(n){o.t=Date.now();try{localStorage.setItem(S,JSON.stringify(o))}catch(e){}}',
    `function f(e){var a=e.target.closest&&e.target.closest('a[href*="${host}/w/"]');if(!a)return;`,
    'var u=new URL(a.href);K.forEach(function(k){if(o[k])u.searchParams.set(k,o[k])});',
    'u.searchParams.set("lp",location.pathname);a.href=u.toString()}',
    'document.addEventListener("click",f,true);document.addEventListener("touchstart",f,true)',
    '}catch(e){}})();',
    '</script>',
  ].join('');
}
