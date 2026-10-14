/*
 * Values only the owner can supply, for the public pages. One file, one place.
 *
 * Rule: a field left as `null` (or an empty list) hides the line or section
 * that depends on it. Nothing here has a made-up fallback, so an empty field
 * never turns into an invented number, name or promise.
 */

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

const WHATSAPP_NUMBER = '966541004029';

export const whatsappHref = (text: string) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

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
   * Real results from the agency's own client work, without client names.
   * Source: the agency's June and July 2026 measurement for a dental clinic
   * (real cost per contact, calls and WhatsApp clicks).
   */
  agencyResults: [
    {
      business: 'عيادة أسنان',
      period: 'يونيو ويوليو 2026',
      lines: [
        { label: 'تكلفة التواصل الحقيقي', before: '5.82 ريال', after: '5.41 ريال' },
        { label: 'نسبة اللي تواصلوا من اللي ضغطوا', before: '23.3%', after: '32.2%' },
      ],
      note: 'نتيجة إدارة يدوية في الوكالة، مو نتيجة المنصة. حطيناها لأن نفس طريقة القراءة هي اللي داخل مُضاعِف.',
    },
  ] as AgencyResult[],

  /** A real audit report with the client details covered. null = hidden. */
  reportSample: null as ReportSample | null,

  /** Set to true only after Google lists the agency as an official Partner. */
  googlePartner: false,

  guarantee: {
    title: 'ضمان أول شهر',
    promise:
      'إذا ما لقى لك مُضاعِف في أول شهر مدفوع هدر أو فرص قيمتها أكثر من اشتراكك، نرجع لك فلوس هالشهر كاملة.',
    terms: [
      'يشمل أول دفعة شهرية بعد التجربة، مرة وحدة لكل عميل ولكل حساب إعلانات.',
      'القياس من القرارات اللي جهّزها لك مُضاعِف خلال أول 30 يوم بعد الدفعة: نجمع «التوفير المتوقع شهرياً» و«الزيادة المتوقعة شهرياً» المكتوبة على كل قرار، سواء اعتمدته أو لا.',
      'لازم يكون الحساب مربوط ويصرف خلال الشهر، لأن الحساب الواقف ما يطلع له قرارات.',
      'تطلب الاسترجاع خلال 14 يوم بعد نهاية الشهر، على الواتساب أو الإيميل، ويرجع المبلغ لنفس البطاقة.',
      'الاسترجاع يلغي الاشتراك.',
    ],
    approved: false,
  } as Guarantee,
};

/** True when a draft-only block may render (preview and local builds, never production). */
export function showDrafts(): boolean {
  return process.env.VERCEL_ENV !== 'production';
}
