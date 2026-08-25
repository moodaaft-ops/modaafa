import {
  AUTOPILOT_MODES,
  AUTOPILOT_SAFE_ACTIONS,
  DEFAULT_AUTOPILOT_SETTINGS,
  type AutopilotMode,
  type AutopilotSettings,
} from './types';

export type AutopilotSettingsInput = {
  mode: AutopilotMode;
  max_daily_changes: number;
  min_confidence: number;
  cooldown_hours: number;
  require_healthy_tracking: boolean;
  anomaly_pause_enabled: boolean;
  confirm_conservative: boolean;
};

export function parseAutopilotSettingsInput(
  payload: Record<string, unknown>
): AutopilotSettingsInput {
  const mode = String(payload.mode ?? 'off') as AutopilotMode;
  if (!AUTOPILOT_MODES.includes(mode)) throw new Error('invalid_mode');

  const maxDailyChanges = numberInRange(payload.max_daily_changes, 1, 3, 'invalid_daily_limit');
  const minConfidence = numberInRange(payload.min_confidence, 0.95, 1, 'invalid_confidence');
  const cooldownHours = numberInRange(payload.cooldown_hours, 24, 168, 'invalid_cooldown');
  const confirmConservative = toBoolean(payload.confirm_conservative);
  if (mode === 'conservative' && !confirmConservative) {
    throw new Error('confirmation_required');
  }

  return {
    mode,
    max_daily_changes: maxDailyChanges,
    min_confidence: minConfidence,
    cooldown_hours: cooldownHours,
    // V1 uses zero-conversion evidence, so healthy conversion tracking and the
    // anomaly stop are hard safety boundaries rather than user preferences.
    require_healthy_tracking: true,
    anomaly_pause_enabled: true,
    confirm_conservative: confirmConservative,
  };
}

export function toAutopilotSettingsRow(
  accountId: string,
  input: AutopilotSettingsInput,
  previous?: Partial<AutopilotSettings> | null,
  now = new Date().toISOString()
) {
  return {
    account_id: accountId,
    mode: input.mode,
    allowed_actions: [...AUTOPILOT_SAFE_ACTIONS],
    max_daily_changes: input.max_daily_changes,
    min_confidence: input.min_confidence,
    cooldown_hours: input.cooldown_hours,
    require_healthy_tracking: true,
    anomaly_pause_enabled: true,
    config_version:
      Number(previous?.config_version ?? DEFAULT_AUTOPILOT_SETTINGS.config_version - 1) + 1,
    terms_accepted_at:
      input.mode === 'conservative'
        ? previous?.terms_accepted_at ?? now
        : previous?.terms_accepted_at ?? null,
    paused_at: input.mode === 'off' ? now : null,
    pause_reason: input.mode === 'off' ? 'user_disabled' : null,
    updated_at: now,
  };
}

/**
 * Database rows are treated as untrusted configuration. Missing or malformed
 * values fall back to the safest possible mode instead of widening execution.
 */
export function normalizeAutopilotSettings(
  accountId: string,
  row?: Partial<AutopilotSettings> | null
): AutopilotSettings {
  const rawMode = String(row?.mode ?? DEFAULT_AUTOPILOT_SETTINGS.mode) as AutopilotMode;
  const mode = AUTOPILOT_MODES.includes(rawMode) ? rawMode : 'off';
  const allowedActions = Array.isArray(row?.allowed_actions)
    ? row.allowed_actions.filter((action) => AUTOPILOT_SAFE_ACTIONS.includes(action as any))
    : [...AUTOPILOT_SAFE_ACTIONS];

  return {
    account_id: accountId,
    mode,
    allowed_actions: allowedActions,
    max_daily_changes: safeNumber(
      row?.max_daily_changes,
      DEFAULT_AUTOPILOT_SETTINGS.max_daily_changes,
      1,
      3
    ),
    min_confidence: safeNumber(
      row?.min_confidence,
      DEFAULT_AUTOPILOT_SETTINGS.min_confidence,
      0.95,
      1
    ),
    cooldown_hours: safeNumber(
      row?.cooldown_hours,
      DEFAULT_AUTOPILOT_SETTINGS.cooldown_hours,
      24,
      168
    ),
    require_healthy_tracking: true,
    anomaly_pause_enabled: true,
    config_version: safeNumber(
      row?.config_version,
      DEFAULT_AUTOPILOT_SETTINGS.config_version,
      1,
      Number.MAX_SAFE_INTEGER
    ),
    terms_accepted_at: stringOrNull(row?.terms_accepted_at),
    paused_at: stringOrNull(row?.paused_at),
    pause_reason: stringOrNull(row?.pause_reason),
    last_run_at: stringOrNull(row?.last_run_at),
  };
}

function numberInRange(value: unknown, min: number, max: number, error: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(error);
  return parsed;
}

function toBoolean(value: unknown) {
  return ['true', '1', 'on', 'yes'].includes(String(value ?? '').toLowerCase());
}

function safeNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}
