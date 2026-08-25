export const AUTOPILOT_FAILED_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type AutopilotRecommendationState = {
  id: string;
  status: string;
  created_at?: string | null;
};

const PERMANENTLY_BLOCKING_STATUSES = [
  'pending',
  'approved',
  'executing',
  'applied',
  'dismissed',
] as const;

/**
 * Respect live/applied/user-dismissed decisions indefinitely. A technical
 * failure may be retried only after a quiet period, and malformed timestamps
 * fail closed rather than creating a duplicate Google Ads mutation.
 */
export function blocksAutopilotFingerprint(
  row: AutopilotRecommendationState | null | undefined,
  now = Date.now()
) {
  if (!row) return false;
  if (PERMANENTLY_BLOCKING_STATUSES.includes(row.status as any)) return true;
  if (row.status !== 'failed') return false;

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : Number.NaN;
  if (!Number.isFinite(createdAt)) return true;
  return now - createdAt < AUTOPILOT_FAILED_RETRY_COOLDOWN_MS;
}

/**
 * Find a recommendation that makes this fingerprint unsafe to create again.
 * The split queries ensure an older applied/dismissed row cannot be hidden by
 * a newer failed retry.
 */
export async function findBlockingAutopilotRecommendation(
  supabase: any,
  accountId: string,
  fingerprint: string,
  now = Date.now()
): Promise<AutopilotRecommendationState | null> {
  const { data: permanent, error: permanentError } = await supabase
    .from('recommendations')
    .select('id, status, created_at')
    .eq('account_id', accountId)
    .eq('fingerprint', fingerprint)
    .in('status', [...PERMANENTLY_BLOCKING_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (permanentError) throw permanentError;
  if (permanent) return permanent;

  const { data: failed, error: failedError } = await supabase
    .from('recommendations')
    .select('id, status, created_at')
    .eq('account_id', accountId)
    .eq('fingerprint', fingerprint)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (failedError) throw failedError;

  return blocksAutopilotFingerprint(failed, now) ? failed : null;
}
