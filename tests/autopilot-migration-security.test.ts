import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve('db/migrations/20260825_autopilot.sql'),
  'utf8'
);

test('autopilot tables are read-only for browser roles', () => {
  for (const table of ['autopilot_settings', 'autopilot_decisions']) {
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon, authenticated`, 'i')
    );
    assert.match(
      migration,
      new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated`, 'i')
    );
  }

  assert.match(migration, /CREATE POLICY autopilot_settings_owner_select[\s\S]*FOR SELECT TO authenticated/i);
  assert.match(migration, /CREATE POLICY autopilot_decisions_owner_select[\s\S]*FOR SELECT TO authenticated/i);
});

test('autopilot settings mutation is service-role-only and fails closed', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.save_autopilot_settings/i);
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = public/i);
  assert.match(
    migration,
    /status = 'active' AND COALESCE\(is_manager, FALSE\) = FALSE/i
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.save_autopilot_settings\(UUID, JSONB, JSONB, TEXT\)\s+FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.save_autopilot_settings\(UUID, JSONB, JSONB, TEXT\)\s+TO service_role/i
  );
});

test('autopilot ships disabled with a single narrow action allowlist', () => {
  assert.match(migration, /mode TEXT NOT NULL DEFAULT 'off'/i);
  assert.match(
    migration,
    /allowed_actions TEXT\[\] NOT NULL DEFAULT ARRAY\['add_negative_keyword'\]::TEXT\[\]/i
  );
  assert.match(migration, /max_daily_changes BETWEEN 1 AND 3/i);
  assert.match(migration, /min_confidence BETWEEN 0\.950 AND 1\.000/i);
  assert.match(migration, /cooldown_hours BETWEEN 24 AND 168/i);
});
