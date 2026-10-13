/**
 * The words and numbers at the top of /home: the assistant's one-paragraph read of
 * the account. Built only from stored rows (the synced campaign cache and the
 * open decisions), never from a model, so it is instant, free and cannot
 * invent a number.
 */
import { moneyMetric } from '@/lib/google-ads/metrics';

export type CampaignCacheRow = {
  status?: string | null;
  metrics_7d?: Record<string, unknown> | null;
};

export type WeekNumbers = {
  spend: number;
  results: number;
  costPerResult: number | null;
  activeCampaigns: number;
  /** False when nothing synced yet or every campaign is stopped with no spend. */
  hasData: boolean;
};

export function weekNumbers(rows: CampaignCacheRow[]): WeekNumbers {
  let spend = 0;
  let results = 0;
  let activeCampaigns = 0;
  for (const row of rows) {
    const cost = moneyMetric(row.metrics_7d ?? null, 'cost');
    const conversions = Number(row.metrics_7d?.conversions ?? 0);
    spend += cost;
    results += Number.isFinite(conversions) ? conversions : 0;
    if (String(row.status ?? '').toUpperCase() === 'ENABLED') activeCampaigns += 1;
  }
  results = Math.round(results * 10) / 10;
  return {
    spend,
    results,
    costPerResult: results > 0 ? spend / results : null,
    activeCampaigns,
    hasData: rows.length > 0 && (spend > 0 || activeCampaigns > 0),
  };
}

/** Riyadh is UTC+3 all year, so the greeting does not depend on the server clock's zone. */
export function greetingFor(now: Date = new Date()): string {
  const hour = (now.getUTCHours() + 3) % 24;
  return hour >= 4 && hour < 12 ? 'صباح الخير' : 'مساء الخير';
}

function resultsLabel(count: number) {
  const n = Math.round(count);
  if (count > 0 && count < 1) return 'أقل من نتيجة وحدة';
  if (n === 1) return 'نتيجة وحدة';
  if (n === 2) return 'نتيجتين';
  if (n >= 3 && n <= 10) return `${n} نتائج`;
  return `${n.toLocaleString('en-US')} نتيجة`;
}

export function decisionsLabel(count: number) {
  if (count === 1) return 'قرار واحد';
  if (count === 2) return 'قرارين';
  if (count >= 3 && count <= 10) return `${count} قرارات`;
  return `${count} قرار`;
}

/**
 * One short paragraph. Plain words, the money with its currency, and what to
 * do next. `money` formats an amount in the account currency.
 */
export function summaryLine(args: { week: WeekNumbers; decisions: number; money: (amount: number) => string }): string {
  const { week, decisions, money } = args;
  const next =
    decisions > 0
      ? ` عندي لك ${decisionsLabel(decisions)} اليوم، ابدأ بأولها.`
      : ' وما فيه شي يحتاج قرارك اليوم، وأنا أراقب الحساب.';
  // Campaigns that exist but spent nothing read as "no spend", not "you spent 0".
  if (!week.hasData || week.spend <= 0) {
    return `ما شفت صرف في حسابك آخر 7 أيام. لو حملاتك واقفة قل لي وأشوف معك السبب.${decisions > 0 ? next : ''}`;
  }
  if (week.results <= 0) {
    return `آخر 7 أيام صرفت ${money(week.spend)} وما انسجلت ولا نتيجة. اسألني ليش، وغالباً السبب واضح.${next}`;
  }
  return `آخر 7 أيام صرفت ${money(week.spend)} وجاك منها ${resultsLabel(week.results)}.${next}`;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, medium: 1, growth: 2 };

export function orderDecisions<T extends { severity?: string | null; status?: string | null; created_at?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    // An approved change waiting for its last press goes first: one tap finishes it.
    const approved = (b.status === 'approved' ? 1 : 0) - (a.status === 'approved' ? 1 : 0);
    if (approved !== 0) return approved;
    const severity = (SEVERITY_RANK[a.severity ?? ''] ?? 3) - (SEVERITY_RANK[b.severity ?? ''] ?? 3);
    if (severity !== 0) return severity;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  });
}

export const SEVERITY_WORD: Record<string, string> = { critical: 'عاجل', medium: 'مهم', growth: 'فرصة' };

/** Messages for the redirects the approve, dismiss and undo forms come back with. */
export const HOME_NOTICES: Record<string, { tone: 'ok' | 'bad'; text: string }> = {
  executed: { tone: 'ok', text: 'تم، نفّذت التغيير على حسابك. تقدر ترجعه خلال 30 يوم.' },
  approved: { tone: 'ok', text: 'سجلت موافقتك. اضغط «نفّذ الحين» لما تكون جاهز.' },
  updated: { tone: 'ok', text: 'تمام، شلته من قائمة اليوم.' },
  reverted: { tone: 'ok', text: 'رجّعت التغيير مثل ما كان.' },
  subscribed: { tone: 'ok', text: 'اشتراكك فعّال. من الحين تعتمد وأنا أنفذ.' },
  'error:subscription_required': { tone: 'bad', text: 'التنفيذ يحتاج اشتراك فعّال. فعّله وارجع لنفس القرار.' },
  'error:manual_review_required': { tone: 'bad', text: 'هذا القرار يحتاج تسويه بنفسك. اسألني وأعطيك الخطوات.' },
  'error:approve_before_execution': { tone: 'bad', text: 'لازم توافق على التغيير قبل التنفيذ.' },
  'error:blocked_by_guardrails': { tone: 'bad', text: 'حمايات الحساب وقفت هذا التغيير عشان ما يضرك.' },
  'error:rollback_unavailable': { tone: 'bad', text: 'التراجع ما عاد متاح لهذا التغيير.' },
  'error:rollback_failed': { tone: 'bad', text: 'قوقل رفض التراجع وما تغيّر شي. اسألني وأشوف السبب.' },
  'error:rollback_recording_failed': { tone: 'bad', text: 'التراجع وصل قوقل بس ما قدرنا نأكد حفظه عندنا. لا تعيده، وفريقنا يراجعه معك.' },
  'error:action_not_found': { tone: 'bad', text: 'ما لقيت هذا التغيير في حسابك.' },
  'error:recommendation_locked': { tone: 'bad', text: 'هذا القرار انطبق أو انشال قبل.' },
  'error:execution_failed': { tone: 'bad', text: 'قوقل رفض التغيير وما تغيّر شي في حسابك. اسألني وأشوف السبب.' },
  'error:already_executing': { tone: 'ok', text: 'التغيير قاعد يتنفذ الحين.' },
};

export function noticeFrom(params: Record<string, string | undefined> | null | undefined) {
  if (!params) return null;
  for (const key of ['executed', 'approved', 'updated', 'reverted', 'subscribed'] as const) {
    if (params[key]) return HOME_NOTICES[key];
  }
  if (params.error) return HOME_NOTICES[`error:${params.error}`] ?? { tone: 'bad' as const, text: 'ما كمل الطلب. جرّب مرة ثانية أو اسألني.' };
  return null;
}

/**
 * The same redirects as noticeFrom, for /home without a plan. There is no
 * chat or approval there, so the only confirmations that can come back are the
 * undo's (and its errors); anything else the URL carries is ignored.
 */
export function lockedNoticeFrom(params: Record<string, string | undefined> | null | undefined) {
  if (!params) return null;
  if (params.reverted) return HOME_NOTICES.reverted;
  if (params.error) return noticeFrom({ error: params.error });
  return null;
}
