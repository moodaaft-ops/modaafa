import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const userId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';

test('service usage migration is repeatable and enforces real PostgreSQL role and quota boundaries', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL AS $$
        SELECT current_setting('request.jwt.claim.role', true)
      $$;
      CREATE TABLE usage_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
        account_id UUID, feature TEXT, metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const migration = readFileSync(new URL('../db/migrations/20260907_service_usage_reservation.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);

    async function role(name: string, sub = '') {
      await db.exec('RESET ROLE');
      await db.query("SELECT set_config('request.jwt.claim.role', $1, false), set_config('request.jwt.claim.sub', $2, false)", [name, sub]);
      await db.exec(`SET ROLE ${name}`);
    }
    async function reserve(id: string) {
      return db.query<{ allowed: boolean; used: number; event_id: string | null }>(`
        SELECT * FROM public.consume_feature_usage($1::uuid, 'execute_action', NULL, 2,
          date_trunc('day', now()), date_trunc('day', now()) + interval '1 day', '{}')
      `, [id]);
    }

    await t.test('anon cannot reserve usage or access its underlying table', async () => {
      await role('anon');
      await assert.rejects(reserve(userId), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM usage_events'), /permission denied/);
    });
    await t.test('authenticated users cannot reserve for another identity', async () => {
      await role('authenticated', userId);
      await assert.rejects(reserve(otherId), /forbidden/);
      const first = await reserve(userId);
      assert.equal(first.rows[0].allowed, true);
      assert.equal(first.rows[0].used, 1);
    });
    await t.test('the service role reserves without impersonation and shares the same limit', async () => {
      await role('service_role');
      const second = await reserve(userId);
      assert.equal(second.rows[0].allowed, true);
      assert.equal(second.rows[0].used, 2);
      const blocked = await reserve(userId);
      assert.equal(blocked.rows[0].allowed, false);
      assert.equal(blocked.rows[0].event_id, null);
    });
    await t.test('browser and background reservations count against one quota', async () => {
      await role('authenticated', userId);
      assert.equal((await reserve(userId)).rows[0].allowed, false);
    });
  } finally {
    await db.close();
  }
});
