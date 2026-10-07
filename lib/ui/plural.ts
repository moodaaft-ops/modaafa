/**
 * Arabic count + noun, grammatically.
 *
 * Arabic has six plural categories and the noun changes with the number:
 * "ساعة واحدة", "ساعتان", "3 ساعات", "11 ساعة". Hand-built strings like
 * `${n} ساعة` are right for one range of numbers and wrong for the rest.
 * Categories come from CLDR through Intl.PluralRules, so there is no table of
 * ranges to get wrong.
 */

export type ArabicNounForms = {
  /** 1, spelled out with the noun: "ساعة واحدة". Used without a digit. */
  one: string;
  /** 2, the dual: "ساعتان". Used without a digit. */
  two: string;
  /** 3 to 10, with a digit: "3 ساعات". */
  few: string;
  /** 11 to 99, with a digit: "11 ساعة". Also the fallback for `other` and `zero`. */
  many: string;
  /** Fractions and anything CLDR leaves in `other`. Defaults to `many`. */
  other?: string;
  /** 0. Defaults to `many`. */
  zero?: string;
};

const rules = new Intl.PluralRules('ar');
const numberFormat = new Intl.NumberFormat('ar-SA-u-nu-latn');

export function arabicCount(count: number, forms: ArabicNounForms): string {
  const n = Number.isFinite(count) ? count : 0;
  const category = rules.select(n);
  if (category === 'one') return forms.one;
  if (category === 'two') return forms.two;
  const digits = numberFormat.format(n);
  if (category === 'few') return `${digits} ${forms.few}`;
  if (category === 'zero') return `${digits} ${forms.zero ?? forms.many}`;
  if (category === 'other') return `${digits} ${forms.other ?? forms.many}`;
  return `${digits} ${forms.many}`;
}

export const ARABIC_UNITS = {
  minute: { one: 'دقيقة واحدة', two: 'دقيقتان', few: 'دقائق', many: 'دقيقة' },
  hour: { one: 'ساعة واحدة', two: 'ساعتان', few: 'ساعات', many: 'ساعة' },
  day: { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يوماً', other: 'يوم' },
  week: { one: 'أسبوع واحد', two: 'أسبوعان', few: 'أسابيع', many: 'أسبوعاً', other: 'أسبوع' },
  month: { one: 'شهر واحد', two: 'شهران', few: 'أشهر', many: 'شهراً', other: 'شهر' },
} satisfies Record<string, ArabicNounForms>;

export function formatHours(count: number) {
  return arabicCount(count, ARABIC_UNITS.hour);
}

export function formatDays(count: number) {
  return arabicCount(count, ARABIC_UNITS.day);
}
