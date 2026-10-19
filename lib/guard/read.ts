/**
 * Read side for the home page and Jarvis: the open findings of one account.
 * Uses the caller's own (RLS) client, so an owner only ever reads their rows.
 */
import { isGuardEnabledForUser } from './flag';
import { cleanName } from './copy';
import type { GuardSeverity } from './types';

export type OpenGuardFinding = {
  id: string;
  code: string;
  severity: GuardSeverity;
  whatAr: string;
  stepAr: string;
  causeAr: string | null;
  escalation: 'none' | 'human';
  firstSeenAt: string;
};

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, info: 3 };

export async function readOpenGuardFindings(
  supabase: any,
  accountId: string,
  options: { limit?: number; includeInfo?: boolean } = {}
): Promise<OpenGuardFinding[]> {
  try {
    let query = supabase
      .from('guard_findings')
      .select('id, code, severity, what_ar, step_ar, cause, escalation, first_seen_at')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .order('first_seen_at', { ascending: false })
      .limit(50);
    if (!options.includeInfo) query = query.neq('severity', 'info');
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return [];
    return data
      .map((row: any) => ({
        id: String(row.id),
        code: String(row.code),
        severity: row.severity as GuardSeverity,
        whatAr: String(row.what_ar ?? ''),
        stepAr: String(row.step_ar ?? ''),
        causeAr: row.cause && row.cause.code !== 'unknown' ? (row.cause.labelAr ?? null) : null,
        escalation: (row.escalation === 'human' ? 'human' : 'none') as 'none' | 'human',
        firstSeenAt: String(row.first_seen_at ?? ''),
      }))
      .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))
      .slice(0, options.limit ?? 5);
  } catch {
    return [];
  }
}

/**
 * Lines for Jarvis' account card. Empty when the guard is off for this owner,
 * when the table is not there yet, or when nothing is open. Text was written
 * by our own rules, but names inside it are merchant data, so it is bounded.
 */
export async function guardCardLines(
  supabase: any,
  accountId: string | null | undefined,
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): Promise<string[]> {
  if (!accountId || !isGuardEnabledForUser(email, env)) return [];
  const open = await readOpenGuardFindings(supabase, accountId, { limit: 5 });
  if (open.length === 0) return [];
  return [
    'تنبيهات الحارس الصباحي المفتوحة على الحساب (من قواعد مو من نموذج، اذكرها للعميل لو سأل عن وضع حسابه):',
    ...open.map(
      (finding) =>
        `  - [${finding.severity}] ${cleanName(finding.whatAr, 200)}${finding.causeAr ? ` | السبب المحتمل: ${cleanName(finding.causeAr, 160)}` : ''} | الخطوة: ${cleanName(finding.stepAr, 200)}`
    ),
  ];
}
