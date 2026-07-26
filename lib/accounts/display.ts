export type AccountDisplaySource = {
  customer_id?: string | null;
  customer_name?: string | null;
};

export function formatGoogleAdsCustomerId(customerId?: string | null) {
  const normalized = String(customerId ?? '').replace(/\D/g, '');
  if (normalized.length !== 10) return normalized || '—';
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

export function googleAdsAccountDisplayName(account?: AccountDisplaySource | null) {
  const name = account?.customer_name?.trim();
  if (name && !isGeneratedFallbackName(name)) return name;
  return 'حساب إعلاني غير مُسمّى';
}

export function googleAdsAccountNameMissing(account?: AccountDisplaySource | null) {
  const name = account?.customer_name?.trim();
  return !name || isGeneratedFallbackName(name);
}

export function isGeneratedFallbackName(name?: string | null) {
  const normalized = name?.trim() ?? '';
  return /^Google Ads\s+\d{3}/i.test(normalized) || normalized.includes('بدون اسم');
}
