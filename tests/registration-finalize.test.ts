import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeRegistration, type RegistrationDb } from '../lib/registration/finalize';
import { buildTikTokEventId } from '../lib/analytics/tiktok';

const USER = '0b3a1d2e-1111-4222-8333-444455556666';
const client = { ip: '9.9.9.9', userAgent: 'UA-now', ttp: 'ttp-now', url: 'https://ai.modaafa.com/welcome', referrer: null };

function fakeDb(status: string, log: { rpc: Array<Record<string, unknown>>; patched: Array<Record<string, unknown>> }, rpcError?: string): RegistrationDb {
  return {
    rpc: async (fn, args) => {
      if (fn === 'record_registration_tiktok') {
        log.patched.push(args);
        return { data: null, error: null };
      }
      log.rpc.push(args);
      return rpcError ? { data: null, error: { message: rpcError } } : { data: [{ result_status: status }], error: null };
    },
  };
}
const newLog = () => ({ rpc: [] as Array<Record<string, unknown>>, patched: [] as Array<Record<string, unknown>> });

const goodUser = {
  id: USER,
  email: 'a@b.co',
  user_metadata: {
    full_name: 'أيمن أمين',
    reg: { phone: '0501234567', attribution: { utm_source: 'tiktok', ttclid: 'E.C.P.abc123' }, client: { ip: '1.1.1.1', ua: 'UA-form', ttp: 'ttp-form' } },
  },
};

test('completes, stores attribution, and sends the server event with the form-time browser data', async () => {
  const log = newLog();
  let sent: Record<string, unknown> | null = null;
  const out = await finalizeRegistration(
    { db: fakeDb('completed', log), sendServerEvent: async (ctx) => ((sent = ctx as never), { status: 'sent', testMode: true }) },
    goodUser,
    { cookieAttribution: {}, client },
  );
  assert.equal(out.status, 'completed');
  assert.equal(log.rpc[0].p_phone_normalized, '+966501234567');
  assert.equal(log.rpc[0].p_event_id, buildTikTokEventId('CompleteRegistration', USER));
  assert.deepEqual((log.rpc[0].p_attribution as Record<string, string>).utm_source, 'tiktok');
  assert.equal((sent as unknown as Record<string, string>).ttclid, 'E.C.P.abc123');
  assert.equal((sent as unknown as Record<string, string>).ip, '1.1.1.1');
  assert.equal((sent as unknown as Record<string, string>).ttp, 'ttp-form');
  assert.equal(log.patched.length, 1);
});

test('the server event is NOT sent twice: a repeat visit gets "already" and no event', async () => {
  const log = newLog();
  let calls = 0;
  const out = await finalizeRegistration(
    { db: fakeDb('already', log), sendServerEvent: async () => (calls++, { status: 'sent', testMode: false }) },
    goodUser,
    { cookieAttribution: {}, client },
  );
  assert.equal(out.status, 'already');
  assert.equal(calls, 0);
});

test('a phone owned by someone else is reported and nothing is sent', async () => {
  const log = newLog();
  let calls = 0;
  const out = await finalizeRegistration(
    { db: fakeDb('phone_taken', log), sendServerEvent: async () => (calls++, { status: 'sent', testMode: false }) },
    goodUser,
    { cookieAttribution: {}, client },
  );
  assert.equal(out.status, 'phone_taken');
  assert.equal(calls, 0);
});

test('missing phone or name asks for details without touching the database', async () => {
  const log = newLog();
  const out = await finalizeRegistration({ db: fakeDb('completed', log) }, { id: USER, user_metadata: { full_name: 'Google User' } }, { cookieAttribution: {}, client });
  assert.equal(out.status, 'needs_details');
  assert.equal(log.rpc.length, 0);
});

test('metadata is user-editable, so a bad phone inside it is re-validated', async () => {
  const log = newLog();
  const out = await finalizeRegistration(
    { db: fakeDb('completed', log) },
    { id: USER, user_metadata: { full_name: 'أيمن', reg: { phone: '12' } } },
    { cookieAttribution: {}, client },
  );
  assert.equal(out.status, 'needs_details');
  assert.equal(log.rpc.length, 0);
});

test('typed details win over metadata, and the cookie is the attribution fallback', async () => {
  const log = newLog();
  const out = await finalizeRegistration(
    { db: fakeDb('completed', log), sendServerEvent: async () => ({ status: 'skipped', reason: 'no_token' }) },
    { id: USER, user_metadata: { full_name: 'قديم', reg: { phone: '0500000000' } } },
    { name: 'جديد', phone: '0555555555', cookieAttribution: { utm_source: 'cookie-src' }, client },
  );
  assert.equal(out.status, 'completed');
  assert.equal(log.rpc[0].p_name, 'جديد');
  assert.equal(log.rpc[0].p_phone_normalized, '+966555555555');
  assert.equal((log.rpc[0].p_attribution as Record<string, string>).utm_source, 'cookie-src');
});

test('a database error is a failure, and TikTok is not called', async () => {
  const log = newLog();
  let calls = 0;
  const out = await finalizeRegistration(
    { db: fakeDb('completed', log, 'boom'), sendServerEvent: async () => (calls++, { status: 'sent', testMode: false }) },
    goodUser,
    { cookieAttribution: {}, client },
  );
  assert.equal(out.status, 'failed');
  assert.equal(calls, 0);
});
