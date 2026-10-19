import { sendEmail } from '@/lib/notifications/email';

/**
 * Every action the small autonomy level runs by itself is reported to the
 * merchant with the way back. The undo itself is the existing one (the
 * "التغييرات الأخيرة" list on the home page, POST /api/actions/rollback, 30-day
 * window); this message only points to it.
 */

export type AutoActionNotice = {
  actionType: string;
  /** What was changed, in the merchant's words (keyword or term). */
  subject: string;
  campaignName?: string | null;
  reasonAr: string;
  appUrl: string;
};

const ACTION_VERB_AR: Record<string, string> = {
  add_negative_keyword: 'منعنا كلمة',
  pause_keyword: 'أوقفنا كلمة',
  shift_budget_pair: 'نقلنا جزء من الميزانية',
};

export function buildAutoActionNotice(notice: AutoActionNotice) {
  const verb = ACTION_VERB_AR[notice.actionType] ?? 'عدّلنا';
  const where = notice.campaignName ? ` في حملة «${notice.campaignName}»` : '';
  const title = `${verb} «${notice.subject}»${where}`;
  const undoUrl = `${notice.appUrl.replace(/\/+$/, '')}/home`;
  const text = [
    `${title}.`,
    notice.reasonAr,
    `لو ما تبي هذا التعديل، ارجع له من «التغييرات الأخيرة» واضغط تراجع: ${undoUrl}`,
  ].join('\n');
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<div dir="rtl" style="text-align:right"><p><strong>${esc(title)}</strong></p><p>${esc(
    notice.reasonAr
  )}</p><p>لو ما تبي هذا التعديل، <a href="${esc(undoUrl)}">افتح التغييرات الأخيرة</a> واضغط تراجع.</p></div>`;
  return { subject: `مُضاعف نفّذ تعديل صغير: ${title}`.slice(0, 150), title, text, html, undoUrl };
}

/** Best effort: a failed mail never fails or repeats the execution. */
export async function notifyAutoAction(to: string | null | undefined, notice: AutoActionNotice) {
  if (!to) return { sent: false as const, reason: 'no_recipient' as const };
  try {
    const mail = buildAutoActionNotice(notice);
    return await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (error) {
    console.error('Autonomy notice failed', error instanceof Error ? error.message : error);
    return { sent: false as const, reason: 'send_failed' as const };
  }
}
