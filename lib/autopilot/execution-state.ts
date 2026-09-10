import { autopilotTargetKey, evaluateAutopilotPolicy } from './policy';
import { normalizeAutopilotSettings } from './settings';
import type { AutopilotCandidate, AutopilotPolicyContext } from './types';

/** Re-read consent and durable mutation reservations, not the best-effort UI ledger. */
export async function assertAutopilotExecutionAuthorized({
  supabase, accountId, action, expectedConfigVersion, trackingStatus,
  globalExecutionEnabled, currentRecommendationId, now = new Date(),
}: {
  supabase: any;
  accountId: string;
  action: AutopilotCandidate;
  expectedConfigVersion: number;
  trackingStatus: AutopilotPolicyContext['trackingStatus'];
  globalExecutionEnabled: boolean;
  currentRecommendationId?: string;
  now?: Date;
}) {
  const { data: row, error } = await supabase.from('autopilot_settings').select('*')
    .eq('account_id', accountId).maybeSingle();
  if (error || !row) throw new Error('Autopilot consent could not be verified');
  const settings = normalizeAutopilotSettings(accountId, row);
  if (settings.config_version !== expectedConfigVersion || !settings.terms_accepted_at || settings.paused_at) {
    throw new Error('Autopilot consent changed or was withdrawn');
  }
  const account = await supabase.from('google_ads_accounts').select('status, is_manager')
    .eq('id', accountId).maybeSingle();
  if (account.error || account.data?.status !== 'active' || account.data?.is_manager !== false) {
    throw new Error('Autopilot account is no longer eligible');
  }

  const cutoff = new Date(now.getTime() - 168 * 60 * 60 * 1000).toISOString();
  const cooldownCutoff = now.getTime() - settings.cooldown_hours * 60 * 60 * 1000;
  const dayStart = startOfSaudiDay(now);
  let executedToday = 0;
  let sameTargetExecutedWithinCooldown = false;
  let foundCurrentReservation = !currentRecommendationId;
  const targetKey = autopilotTargetKey(action);
  for (let offset = 0; ; offset += 500) {
    const result = await supabase.from('recommendations')
      .select('id, status, execution_started_at, action_payload')
      .eq('account_id', accountId).eq('applied_by', 'autopilot')
      .in('status', ['applied', 'executing'])
      .or(`status.eq.executing,execution_started_at.gte.${cutoff}`)
      .order('id', { ascending: true }).range(offset, offset + 499);
    if (result.error || !Array.isArray(result.data)) {
      throw new Error('Autopilot mutation history could not be verified');
    }
    for (const reservation of result.data) {
      if (reservation.id === currentRecommendationId) {
        if (reservation.status !== 'executing') throw new Error('Autopilot reservation changed');
        foundCurrentReservation = true;
        continue;
      }
      // An interrupted request may have changed Google even when no decision
      // log exists. Freeze the account until that reservation is reconciled.
      if (reservation.status === 'executing') throw new Error('An autopilot result needs reconciliation');
      const startedAt = Date.parse(reservation.execution_started_at);
      if (!Number.isFinite(startedAt)) throw new Error('Invalid autopilot execution timestamp');
      if (startedAt >= dayStart) executedToday++;
      const payload = reservation.action_payload;
      if (!payload?.params || !payload.operation) throw new Error('Invalid autopilot execution history');
      if (startedAt >= cooldownCutoff && autopilotTargetKey({
        type: payload.operation, target_id: payload.target_id, params: payload.params,
      } as AutopilotCandidate) === targetKey) sameTargetExecutedWithinCooldown = true;
    }
    if (result.data.length < 500) break;
  }

  if (!foundCurrentReservation) throw new Error('Autopilot reservation is missing');

  const verdict = evaluateAutopilotPolicy({
    settings, action, trackingStatus, globalExecutionEnabled,
    executedToday, sameTargetExecutedWithinCooldown,
  });
  if (verdict.outcome !== 'execute') throw new Error(`Autopilot authorization blocked: ${verdict.code}`);
  return verdict;
}

function startOfSaudiDay(now: Date) {
  const offset = 3 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + offset);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - offset;
}
