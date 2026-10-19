import { normalizeAutonomyLevel, type AutonomyLevel } from './autonomy';

export async function loadAutonomyLevels(supabase: any, accountIds: string[]) {
  const levels = new Map<string, AutonomyLevel>();
  if (accountIds.length === 0) return levels;
  const { data, error } = await supabase
    .from('autopilot_autonomy')
    .select('account_id, level')
    .in('account_id', accountIds);
  // Unreadable means ask_all for everyone: the cautious side.
  if (error) {
    console.error('Autonomy levels unavailable; all accounts stay at ask_all', error);
    return levels;
  }
  for (const row of data ?? []) levels.set(row.account_id, normalizeAutonomyLevel(row.level));
  return levels;
}

export async function saveAutonomyLevel(admin: any, accountId: string, userId: string, level: AutonomyLevel) {
  const { error } = await admin
    .from('autopilot_autonomy')
    .upsert(
      { account_id: accountId, level, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'account_id' }
    );
  if (error) throw error;
}
