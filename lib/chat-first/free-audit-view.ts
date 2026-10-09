import { createAdminClient } from '@/lib/supabase/server';
import type { ChatState } from './contracts';

/**
 * Same number as FREE_AUDITS_PER_ACCOUNT in lib/billing/free-audit.ts (PR57).
 * Kept local so this branch stands alone and can merge before or after 57;
 * once 57 is on main this file can import its summarizer instead.
 */
export const CHAT_FREE_AUDITS_PER_ACCOUNT = 2;

type LedgerRow = { status: string; lease_expires_at?: string | null };

/**
 * Same rules as the server's consume_free_audit: only `completed` rows count,
 * and a `reserved` row only blocks while its lease is still alive. An abandoned
 * reservation is never "used" (task 04 is reviewing that edge; we do not count
 * the whole ledger).
 */
export function freeAuditViewFromLedger(rows: LedgerRow[], now: number = Date.now()): NonNullable<ChatState['freeAudit']> {
  const completed = rows.filter((r) => r.status === 'completed').length;
  if (completed >= CHAT_FREE_AUDITS_PER_ACCOUNT) return 'exhausted';
  const running = rows.some(
    (r) => r.status === 'reserved' && r.lease_expires_at != null && Date.parse(r.lease_expires_at) > now
  );
  return running ? 'in_progress' : 'available';
}

/**
 * Read-only. Any failure (no admin env, ledger table not migrated yet, network)
 * is 'unknown', which the planner treats exactly like before this existed: the
 * audit route stays the only authority and answers with its own 402/409.
 */
export async function readFreeAuditView(customerId: string, admin?: any): Promise<ChatState['freeAudit']> {
  try {
    const client = admin ?? createAdminClient();
    const { data, error } = await client
      .from('free_audit_ledger')
      .select('status, lease_expires_at')
      .eq('customer_id', customerId)
      .in('status', ['completed', 'reserved']);
    if (error || !Array.isArray(data)) return 'unknown';
    return freeAuditViewFromLedger(data);
  } catch {
    return 'unknown';
  }
}
