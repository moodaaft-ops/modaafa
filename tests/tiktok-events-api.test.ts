import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompleteRegistrationPayload,
  sendCompleteRegistration,
  TIKTOK_EVENTS_API_URL,
} from '../lib/analytics/tiktok-events-api';
import { buildTikTokEventId } from '../lib/analytics/tiktok';

const USER = '0b3a1d2e-1111-4222-8333-444455556666';
const ctx = { userId: USER, ttclid: 'E.C.P.abc', ttp: 'ttp-1', ip: '1.2.3.4', userAgent: 'UA', url: 'https://ai.modaafa.com/welcome', eventTime: 1760000000 };
const ENV = { TIKTOK_PIXEL_ID: 'CABCDEFGHIJ123', TIKTOK_EVENTS_API_TOKEN: 'secret-token' };

test('payload uses the same event id as the browser pixel', () => {
  const p = buildCompleteRegistrationPayload('CABCDEFGHIJ123', ctx, undefined)!;
  assert.equal(p.data[0].event, 'CompleteRegistration');
  assert.equal(p.data[0].event_id, buildTikTokEventId('CompleteRegistration', USER));
  assert.equal(p.event_source, 'web');
  assert.equal(p.event_source_id, 'CABCDEFGHIJ123');
  assert.equal(p.data[0].event_time, 1760000000);
  assert.equal(p.data[0].user.ttclid, 'E.C.P.abc');
});

test('payload carries no email, phone or name', () => {
  const text = JSON.stringify(buildCompleteRegistrationPayload('CABCDEFGHIJ123', ctx, undefined));
  assert.doesNotMatch(text, /@|\+966|email|phone/i);
});

test('test_event_code is only added when it looks valid', () => {
  assert.equal(buildCompleteRegistrationPayload('CABCDEFGHIJ123', ctx, 'TEST12345')!.test_event_code, 'TEST12345');
  assert.equal(buildCompleteRegistrationPayload('CABCDEFGHIJ123', ctx, 'bad code!')!.test_event_code, undefined);
  assert.equal(buildCompleteRegistrationPayload('CABCDEFGHIJ123', ctx, '')!.test_event_code, undefined);
});

test('no pixel id means no payload', () => {
  assert.equal(buildCompleteRegistrationPayload('', ctx, undefined), null);
  assert.equal(buildCompleteRegistrationPayload(undefined, ctx, undefined), null);
});

test('sends once with the access token header and reports test mode', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ code: 0, message: 'OK' }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await sendCompleteRegistration(ctx, { env: { ...ENV, TIKTOK_TEST_EVENT_CODE: 'TEST12345' }, fetchImpl });
  assert.deepEqual(out, { status: 'sent', testMode: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TIKTOK_EVENTS_API_URL);
  assert.equal((calls[0].init.headers as Record<string, string>)['Access-Token'], 'secret-token');
});

test('skips quietly without a token or pixel', async () => {
  assert.deepEqual(await sendCompleteRegistration(ctx, { env: { TIKTOK_PIXEL_ID: 'CABCDEFGHIJ123' } }), { status: 'skipped', reason: 'no_token' });
  assert.deepEqual(await sendCompleteRegistration(ctx, { env: { TIKTOK_EVENTS_API_TOKEN: 'x' } }), { status: 'skipped', reason: 'no_pixel' });
});

test('an API error code, a network error and a timeout never throw and never leak the token', async () => {
  const bad = (async () => new Response(JSON.stringify({ code: 40001, message: 'bad' }), { status: 200 })) as unknown as typeof fetch;
  const a = await sendCompleteRegistration(ctx, { env: ENV, fetchImpl: bad });
  assert.equal(a.status, 'failed');

  const boom = (async () => {
    throw new Error('network down secret-token');
  }) as unknown as typeof fetch;
  const b = await sendCompleteRegistration(ctx, { env: ENV, fetchImpl: boom });
  assert.equal(b.status, 'failed');

  const hang = ((_: string, init: RequestInit) =>
    new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
  const c = await sendCompleteRegistration(ctx, { env: ENV, fetchImpl: hang, timeoutMs: 20 });
  assert.equal(c.status, 'failed');

  for (const r of [a, b, c]) assert.doesNotMatch(JSON.stringify(r), /secret-token/);
});
