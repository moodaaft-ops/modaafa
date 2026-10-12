/*
 * Values only the owner can supply. One file, one place.
 *
 * Rule for the landing page: a field left as `null` (or an empty list) hides
 * the section or line that depends on it. Nothing here has a made-up fallback,
 * so an empty field never turns into an invented number, name or promise.
 *
 * To publish a section: fill the field below, run the checks, merge.
 */

export type Testimonial = {
  /** The situation before, in the client's own words or numbers. */
  before: string;
  /** The situation after. */
  after: string;
  /** How long it took, for example "6 أسابيع". */
  period: string;
  name: string;
  business: string;
};

export type ReportSample = {
  /** Label shown on the card, for example the store name. Use the owner's own account, not a client's. */
  accountLabel: string;
  healthScore: number;
  /** Estimated monthly waste in SAR, exactly as the audit printed it. */
  estimatedWasteSar: number;
  /** Data coverage percentage from the audit (live_coverage.coverage_pct). */
  coveragePct: number;
  /** Up to three findings, copied from the real report. */
  findings: string[];
};

/**
 * The one call-to-action wording, used on every button that starts the free
 * audit. Ayman left the wording as a placeholder, so this is the suggestion
 * from the round-3 brief. Change it here and every button follows.
 * Alternative from the brief: «افحص حسابي مجاناً».
 */
export const CTA_TEXT = 'وريني وين تروح فلوسي';

export const ownerConfig = {
  /** Support address on the Mudaafa domain. While null, the footer «الدعم» link opens WhatsApp. */
  supportEmail: null as string | null,

  /** Real testimonials only. An empty list hides the section. */
  testimonials: [] as Testimonial[],

  /**
   * Guarantee text, written and approved by the owner. While null the section
   * stays hidden. Note: /refund currently says paid periods are not refunded,
   * so approving a guarantee means updating that page in the same change.
   */
  guarantee: null as { text: string } | null,

  /**
   * Live proof line under the hero button. The line shows only when the number
   * of audited accounts is at least this value. null = never show.
   */
  proofMinAccounts: null as number | null,

  /** Instagram or other profile of the founder. Shown as a link only when the URL is set. */
  founderHandle: 'aiman.google.ads' as string | null,
  founderProfileUrl: null as string | null,
  /** Path under /public. null = the current generated avatar. */
  founderPhoto: null as string | null,

  /** Name of the free audit as the visitor should read it. null = «الفحص المجاني». */
  freeAuditName: null as string | null,
  /** What the same account analysis costs at the agency, in SAR. null = line hidden. */
  agencyAnalysisValueSar: null as number | null,
  /** A real report with data coverage. null = the product screen stays in its place. */
  reportSample: null as ReportSample | null,

  /** One line under each plan: who it suits by monthly ad spend. null = line hidden. */
  planAudience: { starter: null, growth: null, pro: null } as Record<'starter' | 'growth' | 'pro', string | null>,

  /** Monthly figures in SAR for the comparison above the plans. Both null = comparison hidden. */
  comparison: { mediaBuyerSalarySar: null, agencyFeeSar: null } as {
    mediaBuyerSalarySar: number | null;
    agencyFeeSar: number | null;
  },

  /** Set to true only after Google confirms Mudaafa as an official Partner. */
  googlePartner: false,
};
