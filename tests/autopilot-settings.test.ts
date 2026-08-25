import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAutopilotSettings,
  parseAutopilotSettingsInput,
  toAutopilotSettingsRow,
} from '../lib/autopilot/settings';

test('missing or malformed database settings fail safe to off and bounded defaults', () => {
  const normalized = normalizeAutopilotSettings('account-1', {
    mode: 'dangerous' as any,
    allowed_actions: ['adjust_budget', 'add_negative_keyword'],
    max_daily_changes: 999,
    min_confidence: 0,
    cooldown_hours: 0,
  });
  assert.equal(normalized.mode, 'off');
  assert.deepEqual(normalized.allowed_actions, ['add_negative_keyword']);
  assert.equal(normalized.max_daily_changes, 3);
  assert.equal(normalized.min_confidence, 0.95);
  assert.equal(normalized.cooldown_hours, 48);
});

test('conservative mode requires an explicit confirmation', () => {
  assert.throws(
    () =>
      parseAutopilotSettingsInput({
        mode: 'conservative',
        max_daily_changes: 2,
        min_confidence: 0.97,
        cooldown_hours: 72,
      }),
    /confirmation_required/
  );
});

test('a confirmed conservative policy is parsed within strict bounds', () => {
  const parsed = parseAutopilotSettingsInput({
    mode: 'conservative',
    max_daily_changes: '2',
    min_confidence: '0.97',
    cooldown_hours: '72',
    require_healthy_tracking: 'false',
    anomaly_pause_enabled: 'false',
    confirm_conservative: 'yes',
  });
  assert.equal(parsed.mode, 'conservative');
  assert.equal(parsed.max_daily_changes, 2);
  assert.equal(parsed.min_confidence, 0.97);
  assert.equal(parsed.require_healthy_tracking, true);
  assert.equal(parsed.anomaly_pause_enabled, true);
});

test('V1 safety bounds cannot be widened by a settings request', () => {
  const base = {
    mode: 'observe',
    max_daily_changes: 2,
    min_confidence: 0.97,
    cooldown_hours: 48,
    confirm_conservative: true,
  };
  assert.throws(
    () => parseAutopilotSettingsInput({ ...base, max_daily_changes: 4 }),
    /invalid_daily_limit/
  );
  assert.throws(
    () => parseAutopilotSettingsInput({ ...base, min_confidence: 0.94 }),
    /invalid_confidence/
  );
  assert.throws(
    () => parseAutopilotSettingsInput({ ...base, cooldown_hours: 12 }),
    /invalid_cooldown/
  );
});

test('saving settings increments the version and records opt-in or pause timestamps', () => {
  const now = '2026-08-25T12:00:00.000Z';
  const enabled = toAutopilotSettingsRow(
    'account-1',
    {
      mode: 'conservative',
      max_daily_changes: 2,
      min_confidence: 0.97,
      cooldown_hours: 72,
      require_healthy_tracking: true,
      anomaly_pause_enabled: true,
      confirm_conservative: true,
    },
    { config_version: 4, terms_accepted_at: null },
    now
  );
  assert.equal(enabled.config_version, 5);
  assert.equal(enabled.terms_accepted_at, now);
  assert.equal(enabled.paused_at, null);

  const paused = toAutopilotSettingsRow(
    'account-1',
    { ...enabled, mode: 'off', confirm_conservative: false },
    enabled as any,
    now
  );
  assert.equal(paused.paused_at, now);
  assert.equal(paused.pause_reason, 'user_disabled');
});
