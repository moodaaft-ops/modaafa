import type { OptimizerAction } from '../optimizer-agent';
import { CAMPAIGN_TARGETING_FAMILY, isExtendedOperation } from './types';
import { validateExtendedPayload } from './validate';

/**
 * Last gate before the live mutate for the extended actions, called from
 * checkGuardrails. Guardrails are re-derived from the action itself, not from
 * how it was built:
 *  - the payload is re-validated against the account's own customer id, so a
 *    resource under another account is refused even if it got this far;
 *  - one targeting change per campaign per family per 7 days (titan red rule
 *    6: one change per week), applied when the caller asks for the locks
 *    (queue time or an optimizer card) and failing closed when the history is
 *    unreadable. Chat-prepared changes keep the owner's right to ask again and
 *    get a warning on the card instead (see prepare-change.ts).
 */

export const TARGETING_LOCK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ExtendedGuardVerdict = { ok: true } | { ok: false; code: string };

/** Every action type that shares a weekly lock with `type`. */
export function lockFamilyMembers(type: string): string[] {
  const family = CAMPAIGN_TARGETING_FAMILY[type];
  if (!family) return [];
  return Object.entries(CAMPAIGN_TARGETING_FAMILY)
    .filter(([, value]) => value === family)
    .map(([key]) => key);
}

export async function checkExtendedGuardrails(
  action: OptimizerAction,
  accountId: string,
  supabase: any,
  { applyLocks, nowMs = Date.now() }: { applyLocks: boolean; nowMs?: number }
): Promise<ExtendedGuardVerdict> {
  if (!isExtendedOperation(action.type)) return { ok: false, code: 'not_extended' };

  const { data: account, error } = await supabase
    .from('google_ads_accounts')
    .select('customer_id')
    .eq('id', accountId)
    .maybeSingle();
  const customerId = String(account?.customer_id ?? '').replace(/\D/g, '');
  if (error || !customerId) return { ok: false, code: 'account_metadata_unavailable' };

  // Prepared actions carry `resolved`; validation looks only at the whitelisted keys.
  const checked = validateExtendedPayload(action.type, action.target_id, action.params, customerId);
  if (!checked.ok) return { ok: false, code: `extended_payload_${checked.code}` };

  const family = lockFamilyMembers(action.type);
  if (applyLocks && family.length > 0) {
    const campaign = String((action.params as Record<string, unknown>).campaign_resource ?? '');
    const { data, error: historyError } = await supabase
      .from('ai_actions')
      .select('action_type, payload, created_at')
      .eq('account_id', accountId)
      .in('action_type', family)
      .gte('created_at', new Date(nowMs - TARGETING_LOCK_DAYS * DAY_MS).toISOString());
    if (historyError) return { ok: false, code: 'targeting_history_unreadable' };
    const locked = (data ?? []).some(
      (row: any) => String(row?.payload?.action?.params?.campaign_resource ?? '') === campaign
    );
    if (locked) return { ok: false, code: 'targeting_locked_recent_change' };
  }
  return { ok: true };
}
