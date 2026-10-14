import { formatDateAr, formatMoney, formatNumber } from '../../lib/lifecycle/format';
import { EMPTY_FACTS, type EmailCopy, type EmailFacts } from '../../lib/lifecycle/types';

/**
 * Sample copies for exercising the renderer. These are NOT the product texts
 * (those live in lib/lifecycle/copy.ts); they only need to touch every block
 * type and both kinds of footer.
 */
export const FIXTURE_USER = {
  id: '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33',
  email: 'sara@example.com',
  name: 'سارة العتيبي',
};

export const WEEKLY_FACTS: EmailFacts = {
  ...EMPTY_FACTS,
  firstName: 'سارة',
  weekly: {
    periodStart: '2026-10-04T21:00:00Z',
    periodEnd: '2026-10-11T21:00:00Z',
    currency: 'SAR',
    spend: 12400,
    conversions: 86,
    costPerConversion: 144.19,
    prevSpend: 11800,
    prevConversions: 71,
    highlights: ['كلمات الشبكة الواسعة أخذت ثلث الصرف بدون نتيجة', 'حملة العروض أحسن أداء هذا الأسبوع'],
    pendingCount: 3,
  },
};

/** Weekly summary: three stat blocks, a list, a note, a button, signed by Ayman. */
export const statCopy: EmailCopy = {
  key: 'weekly_report',
  category: 'weekly_report',
  approved: true,
  requires: ['weekly'],
  build: (facts) => {
    const w = facts.weekly;
    if (!w) return null;
    return {
      subject: 'ملخص حسابك الإعلاني لهذا الأسبوع',
      preheader: `صرفت ${formatMoney(w.spend ?? 0, w.currency)} وجاك ${formatNumber(w.conversions ?? 0)} تحويل`,
      blocks: [
        {
          type: 'p',
          text: `هذا ملخص الفترة من ${formatDateAr(w.periodStart)} إلى ${formatDateAr(w.periodEnd)}.`,
        },
        { type: 'stat', label: 'الصرف', value: formatMoney(w.spend ?? 0, w.currency), note: `الأسبوع اللي قبله ${formatMoney(w.prevSpend ?? 0, w.currency)}` },
        { type: 'stat', label: 'التحويلات', value: formatNumber(w.conversions ?? 0), note: `الأسبوع اللي قبله ${formatNumber(w.prevConversions ?? 0)}` },
        { type: 'stat', label: 'تكلفة التحويل', value: formatMoney(w.costPerConversion ?? 0, w.currency) },
        { type: 'p', text: 'اللي لفت انتباهنا:' },
        { type: 'list', items: w.highlights },
        { type: 'note', text: `فيه ${formatNumber(w.pendingCount)} توصيات تنتظر موافقتك، وما ينفذ شي قبلها.` },
      ],
      cta: { label: 'افتح التوصيات', path: '/home' },
      ps: 'لو شفت رقم ما فهمته رد على هذا الإيميل.',
      signer: 'ayman',
    };
  },
};

/** Billing mail: no stop link, signed by the team. */
export const transactionalCopy: EmailCopy = {
  key: 'tx_payment_failed',
  category: 'transactional',
  approved: true,
  build: () => ({
    subject: 'تعذر تجديد اشتراك مُضاعِف',
    preheader: 'راجع وسيلة الدفع حتى ما تتوقف الخصائص المدفوعة',
    blocks: [
      { type: 'p', text: 'ما قدرنا نسحب دفعة اشتراكك هذي المرة.' },
      { type: 'p', text: 'راجع وسيلة الدفع من صفحة الفوترة، وإذا تحدثت البيانات نعيد المحاولة تلقائياً.' },
      { type: 'note', text: 'اشتراكك يبقى شغال خلال فترة السماح.' },
    ],
    cta: { label: 'افتح صفحة الفوترة', path: '/billing' },
    signer: 'team',
  }),
};
