/**
 * Shared rules for the onboarding business form.
 *
 * The browser runs these before submitting so the user sees a problem next to
 * the field instead of a reload that empties the form, and the API route runs
 * the same functions so the two can never disagree about what is valid.
 */

export const BUSINESS_GOALS = ['leads', 'conversions', 'traffic', 'awareness'] as const;
export type BusinessGoal = (typeof BUSINESS_GOALS)[number];

export const BUSINESS_NAME_MAX = 120;
export const MONTHLY_BUDGET_MAX = 1_000_000_000;

export type BusinessFormValues = {
  name: string;
  sector: string;
  website: string;
  monthly_budget: string;
  primary_goal: string;
  target_regions: string;
};

export type BusinessFormField = keyof BusinessFormValues;
export type BusinessFormErrors = Partial<Record<BusinessFormField, string>>;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * People type "example.com" or "www.example.com". `new URL()` rejects both
 * without a scheme, so prepend https:// unless one is already there.
 */
export function normalizeWebsiteInput(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  if (SCHEME.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

/** http(s) only, and a hostname with at least one dot ("example" is a typo). */
export function isSafeWebsite(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      Boolean(url.hostname) &&
      url.hostname.includes('.') &&
      !url.hostname.startsWith('.') &&
      !url.hostname.endsWith('.')
    );
  } catch {
    return false;
  }
}

export function parseMonthlyBudget(raw: string | null | undefined): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return 0;
  // Accept Arabic-Indic digits and thousands separators people paste in.
  const latin = trimmed
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[,،\s]/g, '');
  if (!/^\d+$/.test(latin)) return null;
  const value = Number(latin);
  if (!Number.isFinite(value) || value < 0 || value > MONTHLY_BUDGET_MAX) return null;
  return value;
}

export function parseTargetRegions(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    // Arabic comma (،) and newlines as well as the Latin comma.
    .split(/[,،\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export const BUSINESS_FORM_MESSAGES = {
  name: 'اكتب اسم النشاط بحد أقصى 120 حرفاً',
  website: 'الرابط غير صحيح. مثال صحيح: example.com',
  monthly_budget: 'اكتب الميزانية رقماً صحيحاً بالريال بدون كسور',
  primary_goal: 'اختر هدفاً من الخيارات',
} as const;

export function validateBusinessForm(values: BusinessFormValues): BusinessFormErrors {
  const errors: BusinessFormErrors = {};
  const name = values.name.trim();
  if (!name || name.length > BUSINESS_NAME_MAX) errors.name = BUSINESS_FORM_MESSAGES.name;

  const website = normalizeWebsiteInput(values.website);
  if (website && !isSafeWebsite(website)) errors.website = BUSINESS_FORM_MESSAGES.website;

  if (parseMonthlyBudget(values.monthly_budget) === null) {
    errors.monthly_budget = BUSINESS_FORM_MESSAGES.monthly_budget;
  }

  if (!(BUSINESS_GOALS as readonly string[]).includes(values.primary_goal)) {
    errors.primary_goal = BUSINESS_FORM_MESSAGES.primary_goal;
  }

  return errors;
}
