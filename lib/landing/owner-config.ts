/*
 * Values only the owner can supply, for the public pages. One file, one place.
 *
 * Rule: a field left as `null` (or an empty list) hides the line or section
 * that depends on it. Nothing here has a made-up fallback, so an empty field
 * never turns into an invented number, name or promise.
 */

import { SUPPORT_WHATSAPP_NUMBER } from '@/lib/support/contact';

export type AgencyResult = {
  /** Kind of business, never the client's name. */
  business: string;
  /** When the numbers were measured, for example "يونيو ويوليو 2026". */
  period: string;
  /** Before and after, copied from the agency's own measurement. */
  lines: Array<{ label: string; before: string; after: string }>;
  /** Honest note under the card. */
  note: string;
};

export type ReportSample = {
  accountLabel: string;
  healthScore: number;
  estimatedWasteSar: number;
  findings: string[];
};

export type Guarantee = {
  title: string;
  /** One sentence on the pricing section. */
  promise: string;
  /** Full terms, rendered on /refund under #guarantee. */
  terms: string[];
  /**
   * false = draft. A draft shows on preview deployments only (so the owner can
   * read it in place) and never on production. Flip to true only after the
   * owner approves the wording and the terms.
   */
  approved: boolean;
};

export const whatsappHref = (text: string) => `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

export const WHATSAPP = {
  general: whatsappHref('السلام عليكم، شفت مُضاعِف وعندي سؤال'),
  noAccount: whatsappHref('السلام عليكم، ما عندي حساب إعلانات قوقل وأبي أجرب مُضاعِف'),
  fullManagement: whatsappHref('السلام عليكم، أبي فريق مُضاعفة يدير إعلاناتي في قوقل'),
};

/** The one wording for every button that starts the free audit. */
export const CTA_TEXT = 'افحص حسابك مجاناً';

export const ownerConfig = {
  founderHandle: 'aiman.google.ads',
  founderProfileUrl: 'https://www.instagram.com/aiman.google.ads/',

  /**
   * Live numbers from the database (lib/landing/proof-stats.ts). Each line
   * shows only when its count reaches the minimum. null = never show.
   */
  proofMinAuditedAccounts: 20 as number | null,
  proofMinRecommendations: 100 as number | null,

  /**
   * Real results from the agency's own client work, without client names,
   * each with the numbers the agency measured. Empty = the card is hidden.
   */
  agencyResults: [] as AgencyResult[],

  /** The money line (decisions' estimated monthly value) shows from this many SAR. null = never show. */
  proofMinMonthlyImpactSar: 5000 as number | null,

  /** A real audit report with the client details covered. null = hidden. */
  reportSample: null as ReportSample | null,

  /** The agency is a Google Partner (confirmed by Ayman, 14 Oct 2026). Text badge only, no Google logo. */
  googlePartner: true,

  // Approved by Ayman on 14 Oct 2026 («اخر فكرة الضمان حالياً»): the
  // unconditional first-payment guarantee.
  guarantee: {
    title: 'ضمان أول دفعة',
    promise: 'جرّب أول شهر مدفوع، وإذا ما شفت فايدة نرجع لك فلوسك كاملة بدون أسئلة.',
    terms: [
      'يشمل أول دفعة بعد التجربة المجانية، شهرية كانت أو سنوية، مرة وحدة لكل عميل ولكل حساب إعلانات.',
      'تطلب الاسترجاع خلال 30 يوم من تاريخ الدفعة، على الواتساب أو الإيميل، بدون ما تذكر سبب.',
      'يرجع المبلغ كامل لنفس البطاقة، وموعد ظهوره في كشف حسابك يحدده البنك.',
      'الاسترجاع يلغي الاشتراك، والتعديلات اللي اعتمدتها على حسابك تبقى لك.',
    ],
    approved: true,
  } as Guarantee,
};

/** True when a draft-only block may render (preview and local builds, never production). */
export function showDrafts(): boolean {
  return process.env.VERCEL_ENV !== 'production';
}
