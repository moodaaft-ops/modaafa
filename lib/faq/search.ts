import type { FaqItem } from './data';

// Arabic spelling varies a lot in chat ("ايش" or "إيش", "اعلان" or "إعلان",
// "مجانا" or "مجاناً"), so both sides are flattened before they are compared.
export function normalizeArabic(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // tashkeel and tatweel
    .replace(/[\u0623\u0625\u0622]/g, '\u0627') // alef with hamza or madda -> alef
    .replace(/\u0649/g, '\u064A') // alef maqsura -> yeh
    .replace(/\u0629/g, '\u0647') // teh marbuta -> heh
    .replace(/[\u061F?!.,\u060C:\u061B"'\u00AB\u00BB()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function itemMatches(item: FaqItem, query: string): boolean {
  const words = normalizeArabic(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeArabic([item.q, ...item.a, ...(item.alsoCalled ?? [])].join(' '));
  return words.every((word) => haystack.includes(word));
}
