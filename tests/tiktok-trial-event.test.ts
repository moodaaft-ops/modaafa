import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerEventPayload, sendSubscribe, TIKTOK_EVENTS_API_URL } from '../lib/analytics/tiktok-events-api';
import { buildTikTokEventId } from '../lib/analytics/tiktok';
import { reportTrialStartToTikTok } from '../lib/analytics/tiktok-trial-event';

const USER = '0b3a1d2e-1111-4222-8333-444455556666';
const ENV = { TIKTOK_PIXEL_ID: 'CABCDEFGHIJ123', TIKTOK_EVENTS_API_TOKEN: 'secret-token' };

function fakeAdmin({ source, meta, throwUsers = false }: { source?: unknown; meta?: unknown; throwUsers?: boolean }) {
  return {
    from: (table: string) => {
      assert.equal(table, 'users');
      if (throwUsers) throw new Error('db down');
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { registration_source: source ?? null }, error: null }) }) }) };
    },
    auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: meta ?? {} } }, error: null }) } },
  };
}

test('Subscribe payload reuses the browser pixel event id', () => {
  const p = buildServerEventPayload('Subscribe', 'CABCDEFGHIJ123', { userId: USER, ttclid: 'E_C_P_x' })!;
  assert.equal(p.data[0].event, 'Subscribe');
  assert.equal(p.data[0].event_id, buildTikTokEventId('Subscribe', USER));
  assert.equal(p.data[0].event_id, `sub_${USER}`);
});

test('sendSubscribe posts a Subscribe event', async () => {
  let body: any;
  const out = await sendSubscribe(
    { userId: USER, ttclid: 'E_C_P_x' },
    {
      env: ENV,
      fetchImpl: (async (url: string, init: any) => {
        assert.equal(url, TIKTOK_EVENTS_API_URL);
        body = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ code: 0 }) };
      }) as any,
    },
  );
  assert.deepEqual(out, { status: 'sent', testMode: false });
  assert.equal(body.data[0].event, 'Subscribe');
  assert.equal(body.data[0].user.ttclid, 'E_C_P_x');
});

test('trial event uses the stored click id and the captured client', async () => {
  let ctx: any;
  const out = await reportTrialStartToTikTok({
    admin: fakeAdmin({ source: { ttclid: 'E_C_P_stored' }, meta: { reg: { client: { ttp: 'ttp-1', ip: '1.2.3.4', ua: 'UA' } } } }),
    userId: USER,
    env: ENV,
    send: (async (c: any) => {
      ctx = c;
      return { status: 'sent', testMode: false };
    }) as any,
  });
  assert.equal(out.status, 'sent');
  assert.deepEqual(ctx, { userId: USER, ttclid: 'E_C_P_stored', ttp: 'ttp-1', ip: '1.2.3.4', userAgent: 'UA' });
});

test('falls back to the click id in the auth metadata', async () => {
  let ctx: any;
  await reportTrialStartToTikTok({
    admin: fakeAdmin({ throwUsers: true, meta: { reg: { attribution: { ttclid: 'E_C_P_meta' } } } }),
    userId: USER,
    env: ENV,
    send: (async (c: any) => {
      ctx = c;
      return { status: 'sent', testMode: false };
    }) as any,
  });
  assert.equal(ctx.ttclid, 'E_C_P_meta');
});

test('skips users that cannot be tied to an ad', async () => {
  let called = false;
  const out = await reportTrialStartToTikTok({
    admin: fakeAdmin({ source: { utm_source: 'google' } }),
    userId: USER,
    env: ENV,
    send: (async () => {
      called = true;
      return { status: 'sent', testMode: false };
    }) as any,
  });
  assert.deepEqual(out, { status: 'skipped', reason: 'no_match_keys' });
  assert.equal(called, false);
});

test('no token: no lookups, no send', async () => {
  const out = await reportTrialStartToTikTok({
    admin: { from: () => assert.fail('should not query') } as any,
    userId: USER,
    env: { TIKTOK_PIXEL_ID: 'CABCDEFGHIJ123' },
  });
  assert.deepEqual(out, { status: 'skipped', reason: 'no_token' });
});

test('a throwing sender never escapes', async () => {
  const out = await reportTrialStartToTikTok({
    admin: fakeAdmin({ source: { ttclid: 'E_C_P_x' } }),
    userId: USER,
    env: ENV,
    send: (async () => {
      throw new Error('boom');
    }) as any,
  });
  assert.deepEqual(out, { status: 'failed', detail: 'error' });
});
