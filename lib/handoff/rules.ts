import { ownerConfig } from '@/lib/landing/owner-config';
import { SUPPORT_WHATSAPP_NUMBER } from '@/lib/support/contact';

/**
 * "Bigger than the platform": rule-based, no model. Four reasons, any one is
 * enough to offer the team:
 *   spend_over_threshold  30-day spend above the owner-set line
 *   suspended             the account is suspended by an operator, or Google
 *                         reports the ad account as not enabled
 *   repeated_policy       several ads not approved at once
 *   asked_for_human       the merchant asked for a person
 * Unknown inputs (null) never fire a rule.
 */

export type HandoffReasonCode = 'spend_over_threshold' | 'suspended' | 'repeated_policy' | 'asked_for_human';

export type HandoffInput = {
  /** Last 30 days, SAR. Null when unknown or the account is not in SAR. */
  spend30dSar: number | null;
  suspended: boolean;
  googleDisabled: boolean;
  /** Ads Google marks as not approved right now. Null when unknown. */
  policyFlaggedAds: number | null;
  askedForHuman: boolean;
};

export type HandoffThresholds = {
  monthlySpendThresholdSar: number | null;
  policyFlaggedAdsThreshold: number | null;
};

export type HandoffReason = { code: HandoffReasonCode; text_ar: string };

export type HandoffVerdict = {
  needed: boolean;
  reasons: HandoffReason[];
};

export const DEFAULT_HANDOFF_THRESHOLDS: HandoffThresholds = ownerConfig.handoff;

const formatSar = (value: number) => Math.round(value).toLocaleString('en-US');

export function detectHandoff(
  input: HandoffInput,
  thresholds: HandoffThresholds = DEFAULT_HANDOFF_THRESHOLDS
): HandoffVerdict {
  const reasons: HandoffReason[] = [];

  const spendLine = thresholds.monthlySpendThresholdSar;
  if (
    spendLine !== null &&
    spendLine > 0 &&
    input.spend30dSar !== null &&
    Number.isFinite(input.spend30dSar) &&
    input.spend30dSar > spendLine
  ) {
    reasons.push({
      code: 'spend_over_threshold',
      text_ar: `صرفك آخر 30 يوم ${formatSar(input.spend30dSar)} ريال. عند هذا الحجم يستاهل أحد يمسكه معك.`,
    });
  }
  if (input.suspended || input.googleDisabled) {
    reasons.push({
      code: 'suspended',
      text_ar: 'حسابك واقف أو موقوف. هذا يحتاج شخص يتابعه مع قوقل.',
    });
  }
  const policyLine = thresholds.policyFlaggedAdsThreshold;
  if (
    policyLine !== null &&
    policyLine > 0 &&
    input.policyFlaggedAds !== null &&
    input.policyFlaggedAds >= policyLine
  ) {
    reasons.push({
      code: 'repeated_policy',
      text_ar: `${input.policyFlaggedAds} إعلانات رفضتها قوقل أو قيّدتها. تكرار السياسات يحتاج شخص يعالجه من جذره.`,
    });
  }
  if (input.askedForHuman) {
    reasons.push({ code: 'asked_for_human', text_ar: 'طلبت أحد يكلمك.' });
  }
  return { needed: reasons.length > 0, reasons };
}

export function handoffSummaryLines(args: {
  accountName?: string | null;
  customerId?: string | null;
  reasons: Array<{ code: HandoffReasonCode; text_ar: string }>;
  spend30dSar?: number | null;
}) {
  const lines = ['السلام عليكم، أبي فريق مُضاعفة يمسك حسابي'];
  const name = clean(args.accountName, 80);
  if (name) lines.push(`الحساب: ${name}`);
  const id = clean(args.customerId, 20);
  if (id && /^[0-9-]+$/.test(id)) lines.push(`رقم الحساب: ${id}`);
  if (args.spend30dSar !== null && args.spend30dSar !== undefined && Number.isFinite(args.spend30dSar)) {
    lines.push(`الصرف آخر 30 يوم: ${formatSar(args.spend30dSar)} ريال`);
  }
  for (const reason of args.reasons.slice(0, 4)) lines.push(`- ${reason.text_ar}`);
  return lines;
}

export function handoffWhatsappUrl(args: Parameters<typeof handoffSummaryLines>[0]) {
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(handoffSummaryLines(args).join('\n'))}`;
}

function clean(value: string | null | undefined, max: number) {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const HANDOFF_CARD_COPY = {
  title: 'خلّ فريق مُضاعفة يمسكه',
  body: 'حسابك صار أكبر من اللي تكفيه المنصة لوحدها. اضغط وارسل لنا الملخص على واتساب، وأحد من الفريق يرد عليك.',
  button: 'كلمنا على واتساب',
} as const;
