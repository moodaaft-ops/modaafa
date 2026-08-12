import { formatGoogleAdsCustomerId, googleAdsAccountDisplayName } from './display';
import type { AdsAccountSummary } from './selection';

/** Normalize Arabic spelling variants for forgiving account-name search. */
export function foldArabicSearch(value: string) {
  return value
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Map Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII. */
export function toAsciiDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (character) => {
    const code = character.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function searchGoogleAdsAccounts(accounts: AdsAccountSummary[], query: string) {
  const normalizedQuery = foldArabicSearch(query.trim().toLowerCase());
  if (!normalizedQuery) return accounts;

  const digits = toAsciiDigits(normalizedQuery).replace(/\D/g, '');

  return accounts.filter((account) => {
    const name = foldArabicSearch(account.customer_name?.toLowerCase() ?? '');
    const displayName = foldArabicSearch(googleAdsAccountDisplayName(account).toLowerCase());
    const formattedId = formatGoogleAdsCustomerId(account.customer_id);
    return (
      name.includes(normalizedQuery) ||
      displayName.includes(normalizedQuery) ||
      (digits.length > 0 && account.customer_id.includes(digits)) ||
      formattedId.includes(normalizedQuery)
    );
  });
}
