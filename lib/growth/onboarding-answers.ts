import { GROWTH_OWNER_CONFIG, type GrowthOwnerConfig } from './owner-config';

/**
 * The three questions asked on /welcome before the Google Ads link.
 *
 * Everything the database may hold is listed here once: the form, the API, the
 * SQL CHECK constraints and the agency-lead rule all read these tables, and a
 * test fails if the SQL file and these lists disagree.
 */

export const BUSINESS_TYPES = [
  { key: 'ecommerce', label: 'متجر إلكتروني' },
  { key: 'local_services', label: 'خدمات محلية: عيادة، مطعم، مقاولات' },
  { key: 'real_estate', label: 'عقارات' },
  { key: 'education', label: 'تعليم وتدريب' },
  { key: 'other', label: 'شي ثاني' },
] as const;
export type BusinessTypeKey = (typeof BUSINESS_TYPES)[number]['key'];

/**
 * Monthly ad spend in riyals. The edges are a product choice, not a statistic.
 * `minSar` is the band's lower edge and is what the agency-lead rule compares.
 * 'unknown' has no edge and never counts as a lead.
 */
export const SPEND_BANDS = [
  { key: 'under_3k', label: 'أقل من 3000 ريال', minSar: 0 },
  { key: '3k_10k', label: 'من 3000 إلى 10000 ريال', minSar: 3000 },
  { key: '10k_30k', label: 'من 10000 إلى 30000 ريال', minSar: 10000 },
  { key: 'over_30k', label: 'فوق 30000 ريال', minSar: 30000 },
  { key: 'unknown', label: 'ما أدري بالضبط', minSar: null },
] as const;
export type SpendBandKey = (typeof SPEND_BANDS)[number]['key'];

export const ACCOUNT_MANAGERS = [
  { key: 'self', label: 'أنا بنفسي' },
  { key: 'employee', label: 'موظف أو شريك عندي' },
  { key: 'agency', label: 'وكالة أو مستقل' },
  { key: 'nobody', label: 'ما أحد يديره حالياً' },
] as const;
export type AccountManagerKey = (typeof ACCOUNT_MANAGERS)[number]['key'];

export type OnboardingAnswers = {
  businessType: BusinessTypeKey;
  spendBand: SpendBandKey;
  accountManager: AccountManagerKey;
};

const BUSINESS_KEYS: ReadonlySet<string> = new Set(BUSINESS_TYPES.map((item) => item.key));
const SPEND_KEYS: ReadonlySet<string> = new Set(SPEND_BANDS.map((item) => item.key));
const MANAGER_KEYS: ReadonlySet<string> = new Set(ACCOUNT_MANAGERS.map((item) => item.key));

export type ParsedAnswers =
  | { ok: true; skipped: false; answers: OnboardingAnswers }
  | { ok: true; skipped: true }
  | { ok: false; error: string };

/** Pure. Anything outside the lists above is refused, never stored. */
export function parseOnboardingAnswers(body: unknown): ParsedAnswers {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  const input = body as Record<string, unknown>;
  if (input.skip === true) return { ok: true, skipped: true };

  const { businessType, spendBand, accountManager } = input;
  if (typeof businessType !== 'string' || !BUSINESS_KEYS.has(businessType)) return { ok: false, error: 'invalid_business_type' };
  if (typeof spendBand !== 'string' || !SPEND_KEYS.has(spendBand)) return { ok: false, error: 'invalid_spend_band' };
  if (typeof accountManager !== 'string' || !MANAGER_KEYS.has(accountManager)) return { ok: false, error: 'invalid_account_manager' };

  return {
    ok: true,
    skipped: false,
    answers: {
      businessType: businessType as BusinessTypeKey,
      spendBand: spendBand as SpendBandKey,
      accountManager: accountManager as AccountManagerKey,
    },
  };
}

export function spendBandMin(key: string) {
  return SPEND_BANDS.find((band) => band.key === key)?.minSar ?? null;
}

export function labelFor(list: ReadonlyArray<{ key: string; label: string }>, key: string | null | undefined) {
  return list.find((item) => item.key === key)?.label ?? null;
}

/**
 * Agency lead: spends at or above the owner's chosen band AND is in one of the
 * owner's chosen "who manages it" states. Hidden (always false) while the
 * owner has not picked a band, because a flag without a rule means nothing.
 */
export function isAgencyLead(
  answers: { spendBand: string; accountManager: string } | null | undefined,
  config: Pick<GrowthOwnerConfig, 'agencyLeadMinSpendBand' | 'agencyLeadManagers'> = GROWTH_OWNER_CONFIG
) {
  if (!answers || !config.agencyLeadMinSpendBand) return false;
  const threshold = spendBandMin(config.agencyLeadMinSpendBand);
  const spend = spendBandMin(answers.spendBand);
  if (threshold === null || spend === null) return false;
  if (spend < threshold) return false;
  return config.agencyLeadManagers.includes(answers.accountManager as AccountManagerKey);
}
