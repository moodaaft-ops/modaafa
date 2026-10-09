import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capsForPlan,
  createMockProvider,
  makeBeepWav,
  signVoiceToken,
  speakVoiceTurn,
  startVoiceSession,
  transcribeVoiceTurn,
  verifyVoiceToken,
  type VoiceDeps,
  type VoiceProvider,
} from '../lib/ai/voice-server';
import { readVoiceConfig } from '../lib/ai/voice-session';

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000_000;
const AUDIO = new ArrayBuffer(20_000);
const mime = 'audio/mp4';

function makeDeps(over: Partial<VoiceDeps> = {}, counters = { stt: 0, tts: 0 }) {
  const hits = new Map<string, number>();
  const provider: VoiceProvider = {
    async transcribe() {
      counters.stt++;
      return { ok: true, text: 'حلل الصرف' };
    },
    async speak() {
      counters.tts++;
      return { ok: true, body: new ArrayBuffer(8), contentType: 'audio/mpeg' };
    },
  };
  const deps: VoiceDeps = {
    config: readVoiceConfig({
      VOICE_ASSISTANT_ENABLED: 'true',
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_VOICE_ID: 'v',
      VOICE_TICKET_SECRET: SECRET,
    }),
    nowMs: () => NOW,
    user: { id: 'user-1', email: 'a@b.c' },
    planAssistantDailyLimit: 20,
    provider,
    // Same counting behaviour as the database limiter: allowed until `limit` hits.
    limit: async (key, limit) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { allowed: n <= limit, retryAfterSeconds: 30 };
    },
    ...over,
  };
  return { deps, counters, hits };
}

async function openSession(deps: VoiceDeps) {
  const res = await startVoiceSession(deps);
  assert.equal(res.status, 200);
  return (res as unknown as { json: { session_token: string } }).json.session_token;
}

const upload = (token: string | null, extra: Partial<Parameters<typeof transcribeVoiceTurn>[1]> = {}) => ({
  sessionToken: token,
  mime,
  declaredBytes: AUDIO.byteLength,
  readAudio: async () => AUDIO,
  ...extra,
});

test('tokens verify, and expiry, tampering, wrong user and wrong kind are all rejected', () => {
  const payload = { k: 'turn' as const, u: 'u1', s: 's1', i: 'i1', e: Math.floor(NOW / 1000) + 60 };
  const token = signVoiceToken(payload, SECRET);
  assert.ok(verifyVoiceToken(token, SECRET, { kind: 'turn', userId: 'u1' }, NOW));
  assert.equal(verifyVoiceToken(token, SECRET, { kind: 'turn', userId: 'u1' }, NOW + 120_000), null);
  assert.equal(verifyVoiceToken(token, SECRET, { kind: 'turn', userId: 'u2' }, NOW), null);
  assert.equal(verifyVoiceToken(token, SECRET, { kind: 'session', userId: 'u1' }, NOW), null);
  assert.equal(verifyVoiceToken(token, 'other'.repeat(10), { kind: 'turn', userId: 'u1' }, NOW), null);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, u: 'u2' })).toString('base64url');
  assert.equal(verifyVoiceToken(`${forged}.${mac}`, SECRET, { kind: 'turn', userId: 'u2' }, NOW), null);
  assert.equal(verifyVoiceToken(`${body}.`, SECRET, { kind: 'turn', userId: 'u1' }, NOW), null);
  assert.equal(verifyVoiceToken(null, SECRET, { kind: 'turn', userId: 'u1' }, NOW), null);
});

test('flag off, signed out and no subscription never reach the provider', async () => {
  const off = makeDeps({ config: readVoiceConfig({}) });
  assert.equal((await startVoiceSession(off.deps)).status, 404);
  assert.equal((await transcribeVoiceTurn(off.deps, upload('x'))).status, 404);
  assert.equal((await speakVoiceTurn(off.deps, { ticket: 'x', text: 'مرحبا' })).status, 404);

  const anon = makeDeps({ user: null });
  assert.equal((await startVoiceSession(anon.deps)).status, 401);

  const free = makeDeps({ planAssistantDailyLimit: null });
  assert.equal((await startVoiceSession(free.deps)).status, 402);
  assert.equal((await speakVoiceTurn(free.deps, { ticket: 'x', text: 'مرحبا' })).status, 402);
  for (const m of [off, anon, free]) assert.deepEqual(m.counters, { stt: 0, tts: 0 });
});

test('a full turn works: session, transcribe, then speak with the ticket', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number; json: { text: string; ticket: string } };
  assert.equal(heard.status, 200);
  assert.equal(heard.json.text, 'حلل الصرف');
  const spoken = await speakVoiceTurn(deps, { ticket: heard.json.ticket, text: 'الصرف ثابت اليوم' });
  assert.equal(spoken.status, 200);
  assert.deepEqual(counters, { stt: 1, tts: 1 });
});

test('direct API: speak with no ticket, a forged ticket, or another user ticket plays nothing', async () => {
  const { deps, counters } = makeDeps();
  const bad = [null, '', 'abc', 'abc.def', signVoiceToken({ k: 'turn', u: 'user-2', s: 's', i: 'i', e: Math.floor(NOW / 1000) + 60 }, SECRET), signVoiceToken({ k: 'turn', u: 'user-1', s: 's', i: 'i', e: Math.floor(NOW / 1000) + 60 }, 'z'.repeat(40))];
  for (const ticket of bad) {
    const res = await speakVoiceTurn(deps, { ticket, text: 'اقرأ هذا النص العشوائي' });
    assert.equal(res.status, 403, String(ticket));
  }
  // A session token is not a turn ticket either.
  const sessionToken = await openSession(deps);
  assert.equal((await speakVoiceTurn(deps, { ticket: sessionToken, text: 'نص' })).status, 403);
  assert.equal(counters.tts, 0);
});

test('a ticket is single use: the third playback is refused', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  const ticket = heard.json.ticket;
  assert.equal((await speakVoiceTurn(deps, { ticket, text: 'رد' })).status, 200);
  assert.equal((await speakVoiceTurn(deps, { ticket, text: 'رد' })).status, 200);
  assert.equal((await speakVoiceTurn(deps, { ticket, text: 'نص عشوائي ثالث' })).status, 403);
  assert.equal(counters.tts, 2);
});

test('an expired ticket and over-long spoken text are refused before the provider', async () => {
  const { deps, counters } = makeDeps();
  const old = signVoiceToken({ k: 'turn', u: 'user-1', s: 's', i: 'i9', e: Math.floor(NOW / 1000) - 5 }, SECRET);
  assert.equal((await speakVoiceTurn(deps, { ticket: old, text: 'رد' })).status, 403);
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  assert.equal((await speakVoiceTurn(deps, { ticket: heard.json.ticket, text: 'ا'.repeat(601) })).status, 413);
  assert.equal(counters.tts, 0);
});

test('session cap: the turn after the limit gets 429 and the provider is not called', async () => {
  const { deps, counters } = makeDeps();
  deps.config.caps.sessionMaxTurns = 3;
  const token = await openSession(deps);
  for (let i = 0; i < 3; i++) assert.equal((await transcribeVoiceTurn(deps, upload(token))).status, 200);
  const over = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number; json: { error: string } };
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'session_limit');
  assert.equal(counters.stt, 3);
  // A fresh call starts a new session counter.
  const second = await openSession(deps);
  assert.equal((await transcribeVoiceTurn(deps, upload(second))).status, 200);
});

test('daily cap is tied to the plan quota and cannot be raised above it', async () => {
  const { deps, counters } = makeDeps({ planAssistantDailyLimit: 2 });
  deps.config.caps.dailyTurns = 500;
  assert.equal(capsForPlan(deps.config.caps, 2).dailyTurns, 2);
  const token = await openSession(deps);
  assert.equal((await transcribeVoiceTurn(deps, upload(token))).status, 200);
  assert.equal((await transcribeVoiceTurn(deps, upload(token))).status, 200);
  const over = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number; json: { error: string } };
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'daily_limit');
  assert.equal(counters.stt, 2);
});

test('a session token from another user, a missing one, and an expired one are refused', async () => {
  const { deps, counters } = makeDeps();
  const other = signVoiceToken({ k: 'session', u: 'user-2', s: 's', i: 's', e: Math.floor(NOW / 1000) + 60 }, SECRET);
  const expired = signVoiceToken({ k: 'session', u: 'user-1', s: 's', i: 's', e: Math.floor(NOW / 1000) - 1 }, SECRET);
  for (const t of [other, expired, null, '']) {
    const res = (await transcribeVoiceTurn(deps, upload(t))) as unknown as { status: number; json: { error: string } };
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'session_expired');
  }
  assert.equal(counters.stt, 0);
});

test('audio gates: unsupported type, oversize header, oversize body and empty body', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const code = async (extra: Parameters<typeof upload>[1]) => ((await transcribeVoiceTurn(deps, upload(token, extra))) as unknown as { status: number }).status;
  assert.equal(await code({ mime: 'text/plain' }), 415);
  assert.equal(await code({ mime: '' }), 415);
  assert.equal(await code({ declaredBytes: 9_000_000 }), 413);
  assert.equal(await code({ readAudio: async () => new ArrayBuffer(deps.config.caps.maxAudioBytes + 1), declaredBytes: null }), 413);
  assert.equal(await code({ readAudio: async () => new ArrayBuffer(0), declaredBytes: null }), 422);
  assert.equal(counters.stt, 0);
});

test('an empty transcript is no_speech and issues no ticket; provider failure is 502 or 503', async () => {
  const silent = makeDeps();
  silent.deps.provider = { ...silent.deps.provider, transcribe: async () => ({ ok: true, text: '  ' }) };
  const token = await openSession(silent.deps);
  const res = (await transcribeVoiceTurn(silent.deps, upload(token))) as unknown as { status: number; json: Record<string, unknown> };
  assert.equal(res.status, 422);
  assert.equal(res.json.ticket, undefined);

  const down = makeDeps();
  down.deps.provider = { ...down.deps.provider, transcribe: async () => ({ ok: false, status: 500 }) };
  assert.equal(((await transcribeVoiceTurn(down.deps, upload(await openSession(down.deps)))) as unknown as { status: number }).status, 502);

  const paid = makeDeps();
  paid.deps.provider = { ...paid.deps.provider, speak: async () => ({ ok: false, status: 402 }) };
  const t = (await transcribeVoiceTurn(paid.deps, upload(await openSession(paid.deps)))) as unknown as { json: { ticket: string } };
  const spoken = (await speakVoiceTurn(paid.deps, { ticket: t.json.ticket, text: 'رد' })) as unknown as { status: number; json: { error: string } };
  assert.equal(spoken.status, 503);
  assert.equal(spoken.json.error, 'voice_plan_required');
});

test('when the limiter storage is down the paid call fails closed with 503', async () => {
  const { deps, counters } = makeDeps({
    limit: async () => {
      throw new Error('rate_limit_unavailable');
    },
  });
  assert.equal((await startVoiceSession(deps)).status, 503);
  const token = signVoiceToken({ k: 'session', u: 'user-1', s: 's', i: 's', e: Math.floor(NOW / 1000) + 60 }, SECRET);
  assert.equal((await transcribeVoiceTurn(deps, upload(token))).status, 503);
  assert.equal(counters.stt, 0);
});

test('the mock provider returns a playable WAV and only transcribes a real-sized recording', async () => {
  const wav = new Uint8Array(makeBeepWav());
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  const mock = createMockProvider('نص تجريبي');
  assert.deepEqual(await mock.transcribe(new ArrayBuffer(100), 'audio/mp4'), { ok: true, text: '' });
  assert.deepEqual(await mock.transcribe(new ArrayBuffer(5000), 'audio/mp4'), { ok: true, text: 'نص تجريبي' });
  const spoken = await mock.speak('x');
  assert.ok(spoken.ok && spoken.contentType === 'audio/wav');
});
