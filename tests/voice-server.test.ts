import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capsForPlan,
  createMockProvider,
  grantSpeech,
  makeBeepWav,
  signVoiceToken,
  speakVoiceTurn,
  endVoiceSession,
  startVoiceSession,
  textFingerprint,
  transcribeVoiceTurn,
  verifyChatVoiceTicket,
  verifyVoiceToken,
  type VoiceDeps,
  type VoiceProvider,
} from '../lib/ai/voice-server';
import { readVoiceConfig } from '../lib/ai/voice-session';

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000_000;
import { encodeWav16, inspectWav, PcmCapture } from '../lib/ai/voice-pcm';

/** What the browser uploads: 16-bit mono WAV at 16 kHz. */
const wavOf = (seconds: number, rate = 16_000) => encodeWav16([Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.sin(i / 20) * 0.3)], rate, rate);
const AUDIO = wavOf(2);
const mime = 'audio/wav';

/** Stand-in for the shared limits store marker: one set, visible to every caller, like the real table. */
function makeSessions(ended = new Set<string>()): VoiceDeps['sessions'] & { ended: Set<string> } {
  return {
    ended,
    async isEnded(id) {
      return ended.has(id);
    },
    async end(id) {
      ended.add(id);
    },
  };
}

function makeDeps(over: Partial<VoiceDeps> = {}, counters = { stt: 0, tts: 0 }) {
  const hits = new Map<string, number>();
  const sessions = makeSessions();
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
    tier: 'paid',
    provider,
    sessions,
    // Same counting behaviour as the database limiter: allowed until `limit` hits.
    limit: async (key, limit) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { allowed: n <= limit, retryAfterSeconds: 30 };
    },
    ...over,
  };
  return { deps, counters, hits, sessions };
}

/** What the chat route does: verify the turn ticket against the message, then grant speech for the reply. */
async function chatGrant(deps: VoiceDeps, ticket: string, message = 'حلل الصرف', reply = 'الصرف ثابت اليوم') {
  const check = await verifyChatVoiceTicket(deps, 'user-1', ticket, message);
  assert.ok(check.ok, JSON.stringify(check));
  const grant = grantSpeech(deps, 'user-1', check as { ticketId: string; sessionId: string }, reply);
  assert.ok(grant);
  return grant as { spoken_text: string; speak_ticket: string };
}

/** The route resolves the account; these tests default to a call with no account. */
const speakT = (deps: VoiceDeps, input: { ticket: string | null; text: unknown; signal?: AbortSignal; accountKey?: string }) =>
  speakVoiceTurn(deps, { accountKey: '-', ...input });

async function openSession(deps: VoiceDeps) {
  const res = await startVoiceSession(deps);
  assert.equal(res.status, 200);
  return (res as unknown as { json: { session_token: string } }).json.session_token;
}

const upload = (token: string | null, extra: Partial<Parameters<typeof transcribeVoiceTurn>[1]> = {}) => ({
  sessionToken: token,
  accountKey: '-',
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
  assert.equal((await speakT(off.deps, { ticket: 'x', text: 'مرحبا' })).status, 404);

  const anon = makeDeps({ user: null });
  assert.equal((await startVoiceSession(anon.deps)).status, 401);

  const free = makeDeps({ planAssistantDailyLimit: null });
  assert.equal((await startVoiceSession(free.deps)).status, 402);
  assert.equal((await speakT(free.deps, { ticket: 'x', text: 'مرحبا' })).status, 402);
  for (const m of [off, anon, free]) assert.deepEqual(m.counters, { stt: 0, tts: 0 });
});

test('a full turn works: session, transcribe, then speak with the ticket', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number; json: { text: string; ticket: string } };
  assert.equal(heard.status, 200);
  assert.equal(heard.json.text, 'حلل الصرف');
  const grant = await chatGrant(deps, heard.json.ticket);
  const spoken = await speakT(deps, { ticket: grant.speak_ticket, text: grant.spoken_text });
  assert.equal(spoken.status, 200);
  assert.deepEqual(counters, { stt: 1, tts: 1 });
});

test('direct API: speak with no ticket, a forged ticket, or another user ticket plays nothing', async () => {
  const { deps, counters } = makeDeps();
  const bad = [null, '', 'abc', 'abc.def', signVoiceToken({ k: 'turn', u: 'user-2', s: 's', i: 'i', e: Math.floor(NOW / 1000) + 60 }, SECRET), signVoiceToken({ k: 'turn', u: 'user-1', s: 's', i: 'i', e: Math.floor(NOW / 1000) + 60 }, 'z'.repeat(40))];
  for (const ticket of bad) {
    const res = await speakT(deps, { ticket, text: 'اقرأ هذا النص العشوائي' });
    assert.equal(res.status, 403, String(ticket));
  }
  // A session token is not a turn ticket either.
  const sessionToken = await openSession(deps);
  assert.equal((await speakT(deps, { ticket: sessionToken, text: 'نص' })).status, 403);
  assert.equal(counters.tts, 0);
});

test('a speak ticket is single use: the third playback is refused', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  const grant = await chatGrant(deps, heard.json.ticket);
  const play = () => speakT(deps, { ticket: grant.speak_ticket, text: grant.spoken_text });
  assert.equal((await play()).status, 200);
  assert.equal((await play()).status, 200);
  assert.equal((await play()).status, 403);
  assert.equal(counters.tts, 2);
});

test('a speak ticket plays only the reply it was granted for, never free text', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  const grant = await chatGrant(deps, heard.json.ticket);
  for (const text of ['نص عشوائي مختلف تماماً', grant.spoken_text + ' زيادة', 'x']) {
    assert.equal((await speakT(deps, { ticket: grant.speak_ticket, text })).status, 403, text);
  }
  // A turn ticket (the transcribe leg) is not a speak ticket either.
  const turn = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  assert.equal((await speakT(deps, { ticket: turn.json.ticket, text: grant.spoken_text })).status, 403);
  assert.equal(counters.tts, 0);
});

test('chat voice check: wrong message, other user, replay and missing secret are refused', async () => {
  const { deps } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { text: string; ticket: string } };
  const t = heard.json.ticket;
  const bad = await verifyChatVoiceTicket(deps, 'user-1', t, 'سؤال مختلف عما قيل');
  assert.equal(bad.ok, false);
  assert.equal((await verifyChatVoiceTicket(deps, 'user-2', t, heard.json.text)).ok, false);
  assert.equal((await verifyChatVoiceTicket(deps, 'user-1', 'abc.def', heard.json.text)).ok, false);
  assert.equal((await verifyChatVoiceTicket(deps, 'user-1', t, heard.json.text)).ok, true);
  // Same ticket again: one chat call per spoken question.
  assert.equal((await verifyChatVoiceTicket(deps, 'user-1', t, heard.json.text)).ok, false);
  const off = makeDeps({ config: readVoiceConfig({}) });
  assert.equal((await verifyChatVoiceTicket(off.deps, 'user-1', t, heard.json.text)).ok, false);
  assert.equal(textFingerprint(' مرحبا   بك '), textFingerprint('مرحبا بك'));
});

test('free tier: a small allowance when configured, closed at zero, clamped by the daily cap', async () => {
  const free = makeDeps({ tier: 'free', planAssistantDailyLimit: 2 });
  const token = await openSession(free.deps);
  assert.equal((await transcribeVoiceTurn(free.deps, upload(token))).status, 200);
  assert.equal((await transcribeVoiceTurn(free.deps, upload(token))).status, 200);
  assert.equal((await transcribeVoiceTurn(free.deps, upload(token))).status, 429);
  const started = (await startVoiceSession(free.deps)) as unknown as { json: { tier: string } };
  assert.equal(started.json.tier, 'free');
  const closed = makeDeps({ tier: null, planAssistantDailyLimit: null });
  assert.equal((await startVoiceSession(closed.deps)).status, 402);
});

test('an expired ticket and over-long spoken text are refused before the provider', async () => {
  const { deps, counters } = makeDeps();
  const old = signVoiceToken({ k: 'speak', u: 'user-1', s: 's', i: 'i9', e: Math.floor(NOW / 1000) - 5, h: textFingerprint('رد') }, SECRET);
  assert.equal((await speakT(deps, { ticket: old, text: 'رد' })).status, 403);
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  const grant = await chatGrant(deps, heard.json.ticket);
  assert.equal((await speakT(deps, { ticket: grant.speak_ticket, text: 'ا'.repeat(601) })).status, 413);
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
  // Compressed formats are refused outright: their length cannot be verified from the bytes.
  assert.equal(await code({ mime: 'audio/webm;codecs=opus' }), 415);
  assert.equal(await code({ mime: 'audio/mp4' }), 415);
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
  const g = await chatGrant(paid.deps, t.json.ticket);
  const spoken = (await speakT(paid.deps, { ticket: g.speak_ticket, text: g.spoken_text })) as unknown as { status: number; json: { error: string } };
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
  assert.deepEqual(await mock.transcribe(new ArrayBuffer(100), 'audio/wav'), { ok: true, text: '' });
  assert.deepEqual(await mock.transcribe(new ArrayBuffer(5000), 'audio/wav'), { ok: true, text: 'نص تجريبي' });
  const spoken = await mock.speak('x');
  assert.ok(spoken.ok && spoken.contentType === 'audio/wav');
});

import { readFileSync } from 'node:fs';
import { peekRateLimitWindow } from '../lib/security/rate-limit';

test('source guards: one mic open call inside startCall, ticket checked before any model spend, mock labelled', () => {
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  assert.equal(panel.match(/getUserMedia\(/g)?.length, 1);
  const startCall = panel.slice(panel.indexOf('async function startCall'), panel.indexOf('function toggleMute'));
  assert.ok(startCall.includes('getUserMedia('));
  assert.ok(panel.includes('وضع تجريبي: هذا محاكي مو صوت حقيقي'));
  assert.ok(panel.includes('إنهاء المكالمة'));

  const chat = readFileSync('app/api/chat/start/route.ts', 'utf8');
  const check = chat.indexOf('verifyChatVoiceTicket(');
  const spend = chat.indexOf('resolveLanguage({');
  assert.ok(check > -1 && spend > check, 'ticket must be verified before the language layer (model spend)');
  assert.ok(chat.indexOf('accountId ?? ') > -1, 'ticket must be checked against the loaded account');
});

test('voice rides the chat-first entry: no old assistant path, no subscription gate, no history reads', () => {
  const files = [
    'app/(dashboard)/assistant/voice-call-panel.tsx',
    'app/(dashboard)/start/start-client.tsx',
    'lib/ai/voice-server.ts',
    'lib/ai/voice-route-deps.ts',
    'app/api/voice/session/route.ts',
  ];
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes('/api/chat/assistant'), `${f} must not use the old assistant path`);
  // The reply path itself never demands a subscription, so a free caller gets replies.
  const chat = readFileSync('app/api/chat/start/route.ts', 'utf8');
  assert.ok(!chat.includes('consumeFeatureUsage') && !chat.includes("'subscription_required'"));
  // The call never loads any history: a switched or previous account's conversation is not readable from it.
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  assert.ok(!/method:\s*'GET'/.test(panel) && !panel.includes('/api/chat/start'));
  const session = readFileSync('app/api/voice/session/route.ts', 'utf8');
  assert.ok(session.includes('loadChatState('), 'session account comes from the same resolver as the chat');
});

test('account switch ends the call: the panel watches customerId and the server refuses the old ticket', () => {
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  assert.ok(panel.includes('customerRef.current !== customerId') && panel.includes('endCall()'));
  const client = readFileSync('app/(dashboard)/start/start-client.tsx', 'utf8');
  assert.ok(client.includes("fatal: 'account_changed'"));
  // Ending a call aborts the request in flight and invalidates the running turn.
  const end = panel.slice(panel.indexOf('const endCall'), panel.indexOf('// Hard ceiling'));
  assert.ok(end.includes('turnRef.current += 1') && end.includes('releaseMic()') && end.includes('stopPlayback()'));
  assert.ok(panel.includes('abortRef.current?.abort()'));
});

test('account scoping: a ticket from account A never works on account B or on a call with no account', async () => {
  const { deps } = makeDeps();
  const open = async (account: string) => {
    const r = (await startVoiceSession(deps, account)) as unknown as { json: { session_token: string } };
    return r.json.session_token;
  };
  const heardOn = async (account: string) => {
    const t = (await transcribeVoiceTurn(deps, upload(await open(account), { accountKey: account }))) as unknown as { json: { text: string; ticket: string } };
    return t.json;
  };
  const a = await heardOn('acct-A');
  const wrong = await verifyChatVoiceTicket(deps, 'user-1', a.ticket, a.text, 'acct-B');
  assert.deepEqual(wrong, { ok: false, status: 409, error: 'account_changed' });
  // The switch ended the call on the server: going back to A does not bring it back.
  assert.deepEqual(await verifyChatVoiceTicket(deps, 'user-1', a.ticket, a.text, 'acct-A'), { ok: false, status: 401, error: 'session_ended' });
  const none = await heardOn('-');
  assert.equal((await verifyChatVoiceTicket(deps, 'user-1', none.ticket, none.text, 'acct-A')).ok, false);
  const b = await heardOn('acct-B');
  const granted = (await verifyChatVoiceTicket(deps, 'user-1', b.ticket, b.text, 'acct-B')) as { ok: true; ticketId: string; sessionId: string; accountKey: string };
  assert.equal(granted.accountKey, 'acct-B');
});

test('an expired or cancelled call cannot continue: expired session, expired ticket, and a ticket outliving its session window', async () => {
  const { deps } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { text: string; ticket: string } };
  // 11 minutes later the session (10 minute default) is gone, and so is the ticket (3 minutes).
  const later = { ...deps, nowMs: () => NOW + 11 * 60_000 };
  assert.equal(((await transcribeVoiceTurn(later, upload(token))) as unknown as { status: number }).status, 401);
  assert.equal((await verifyChatVoiceTicket(later, 'user-1', heard.json.ticket, heard.json.text)).ok, false);
});

test('approvals: spoken consent is only an offer on screen, never applied by the call', async () => {
  const { planTurn } = await import('../lib/chat-first/orchestrator');
  const state: any = {
    accountLinked: true,
    accountName: 'x',
    customerId: '1234567890',
    subscriptionActive: true,
    latestAudit: { id: 'a', healthScore: 50, findingsCount: 3, estimatedMonthlyWaste: 10, ranAt: new Date().toISOString() },
    recommendations: [{ id: 'r1', title: 'خفض', description: null, severity: 'critical', status: 'pending', executable: true }],
  };
  for (const said of ['أوافق', 'نفذ الحين', 'أيوه', 'موافق ونفذ', 'نعم', 'نفذ كل التوصيات']) {
    const turn = planTurn(said, state);
    // A pending recommendation is never offered as directly executable by speech.
    assert.ok(!turn.actions.some((a) => a.action.type === 'execute'), `${said}: execute offered while pending`);
    // Nothing is claimed as done in the spoken reply.
    assert.ok(!/تم التنفيذ|نفذت|طبقت/.test(turn.reply), `${said}: reply claims completion`);
  }
  // The approve button is an on-screen HTML form to the guarded route, tapped by a person.
  const client = readFileSync('app/(dashboard)/start/start-client.tsx', 'utf8');
  assert.ok(client.includes('<form method="post" action="/api/recommendations/action">'));
  assert.equal(client.match(/\/api\/recommendations\/action/g)?.length, 1, 'only the form posts to the approval route');
  // The call code never reaches the approval route, and a voice turn sends the transcript as message only.
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  assert.ok(!panel.includes('/api/recommendations'));
  const voiceCall = client.slice(client.indexOf('<VoiceCallPanel'));
  assert.ok(/sendRef\.current\(\s*\{\s*message:/.test(voiceCall) && !/sendRef\.current\(\s*\{[^}]*action/.test(voiceCall));
});

test('cost estimate document carries its assumptions and the untested warning', () => {
  const doc = readFileSync('docs/voice-cost-estimate.md', 'utf8');
  assert.ok(doc.includes('لم يُقَس حياً') && doc.includes('0.04') && doc.includes('0.22'));
});

// ------------------------------------------------ server-side session end

async function liveTurn(deps: VoiceDeps, account = '-') {
  const opened = (await startVoiceSession(deps, account)) as unknown as { json: { session_token: string } };
  const token = opened.json.session_token;
  const heard = (await transcribeVoiceTurn(deps, upload(token, { accountKey: account }))) as unknown as { json: { text: string; ticket: string } };
  return { token, ...heard.json };
}

test('end: the session, its turn ticket and its speak ticket all stop working, and the provider is never reached again', async () => {
  const { deps, counters, hits, sessions } = makeDeps();
  const { token, text, ticket } = await liveTurn(deps);
  const grant = await chatGrant(deps, ticket, text); // a speak ticket issued before the end
  const sttBefore = counters.stt;

  const ended = await endVoiceSession(deps, { sessionToken: token });
  assert.equal(ended.status, 200);
  assert.equal(sessions.ended.size, 1);

  // Same session token: refused before any counter or provider.
  const again = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number; json: { error: string } };
  assert.deepEqual([again.status, again.json.error], [401, 'session_ended']);
  assert.equal(counters.stt, sttBefore);
  // A speak ticket issued before the end cannot be played after it.
  const played = (await speakT(deps, { ticket: grant.speak_ticket, text: grant.spoken_text })) as unknown as { status: number; json: { error: string } };
  assert.deepEqual([played.status, played.json.error], [401, 'session_ended']);
  assert.equal(counters.tts, 0);
  // A turn ticket issued before the end cannot start a chat turn, and the replay does not consume it.
  const replay = await verifyChatVoiceTicket(deps, 'user-1', ticket, text);
  assert.deepEqual(replay, { ok: false, status: 401, error: 'session_ended' });
  assert.equal(hits.get(`voice_chat:${ticketIdOf(ticket)}`) ?? 0, 1, 'only the original use consumed it; the replay did not');
  // Ending twice is harmless.
  assert.equal((await endVoiceSession(deps, { sessionToken: token })).status, 200);
});

test('end: only the owner can end a call, and an expired token has nothing left to revoke', async () => {
  const { deps, sessions } = makeDeps();
  const token = await openSession(deps);
  const other = { ...deps, user: { id: 'user-2', email: 'x@y.z' } } as VoiceDeps;
  await endVoiceSession(other, { sessionToken: token });
  assert.equal(sessions.ended.size, 0);
  const later = { ...deps, nowMs: () => NOW + 11 * 60_000 };
  await endVoiceSession(later, { sessionToken: token });
  assert.equal(sessions.ended.size, 0);
  assert.equal((await endVoiceSession({ ...deps, user: null }, { sessionToken: token })).status, 401);
  assert.equal((await endVoiceSession({ ...deps, config: readVoiceConfig({}) }, { sessionToken: token })).status, 404);
});

test('account switch ends the call on the server for good, including for later tickets', async () => {
  const { deps, counters, sessions } = makeDeps();
  const opened = (await startVoiceSession(deps, 'acct-A')) as unknown as { json: { session_token: string } };
  const token = opened.json.session_token;
  // The browser (or another tab) now sits on account B.
  const onB = (await transcribeVoiceTurn(deps, upload(token, { accountKey: 'acct-B' }))) as unknown as { status: number; json: { error: string } };
  assert.deepEqual([onB.status, onB.json.error], [409, 'account_changed']);
  assert.equal(counters.stt, 0);
  assert.equal(sessions.ended.size, 1);
  // Switching back does not resurrect it.
  const backOnA = (await transcribeVoiceTurn(deps, upload(token, { accountKey: 'acct-A' }))) as unknown as { status: number; json: { error: string } };
  assert.deepEqual([backOnA.status, backOnA.json.error], [401, 'session_ended']);
  assert.equal(counters.stt, 0);
});

test('a speak ticket from account A does not speak on account B, and ends the call', async () => {
  const { deps, counters } = makeDeps();
  const { text, ticket } = await liveTurn(deps, 'acct-A');
  const check = await verifyChatVoiceTicket(deps, 'user-1', ticket, text, 'acct-A');
  assert.ok(check.ok);
  const grant = grantSpeech(deps, 'user-1', check as { ticketId: string; sessionId: string; accountKey: string }, 'الصرف ثابت اليوم')!;
  const wrong = (await speakT(deps, { ticket: grant.speak_ticket, text: grant.spoken_text, accountKey: 'acct-B' })) as unknown as { status: number; json: { error: string } };
  assert.deepEqual([wrong.status, wrong.json.error], [409, 'account_changed']);
  const right = (await speakT(deps, { ticket: grant.speak_ticket, text: grant.spoken_text, accountKey: 'acct-A' })) as unknown as { status: number; json: { error: string } };
  assert.deepEqual([right.status, right.json.error], [401, 'session_ended']);
  assert.equal(counters.tts, 0);
});

test('parallel requests: one session at its turn cap lets exactly one through, one ticket works once, and after end both are refused', async () => {
  const config = readVoiceConfig({
    VOICE_ASSISTANT_ENABLED: 'true',
    ELEVENLABS_API_KEY: 'k',
    ELEVENLABS_VOICE_ID: 'v',
    VOICE_TICKET_SECRET: SECRET,
    VOICE_SESSION_MAX_TURNS: '1',
  });
  assert.equal(config.caps.sessionMaxTurns, 1);
  const { deps, counters } = makeDeps({ config });
  const token = await openSession(deps);
  const [a, b] = (await Promise.all([transcribeVoiceTurn(deps, upload(token)), transcribeVoiceTurn(deps, upload(token))])) as unknown as Array<{ status: number }>;
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.equal(counters.stt, 1);

  // One turn ticket, two parallel chat calls: only one passes.
  const free = makeDeps();
  const { text, ticket } = await liveTurn(free.deps);
  const [x, y] = await Promise.all([verifyChatVoiceTicket(free.deps, 'user-1', ticket, text), verifyChatVoiceTicket(free.deps, 'user-1', ticket, text)]);
  assert.deepEqual([x.ok, y.ok].sort(), [false, true]);

  // After the end, two parallel uses of the same session are both refused before the provider.
  const post = makeDeps();
  const open = await openSession(post.deps);
  await endVoiceSession(post.deps, { sessionToken: open });
  const both = (await Promise.all([transcribeVoiceTurn(post.deps, upload(open)), transcribeVoiceTurn(post.deps, upload(open))])) as unknown as Array<{ status: number }>;
  assert.deepEqual(both.map((r) => r.status), [401, 401]);
  assert.equal(post.counters.stt, 0);
});

test('an end that lands while the provider is working leaves a ticket nobody can use', async () => {
  const sessions = makeSessions();
  let liveSession = '';
  const { deps } = makeDeps({
    sessions,
    provider: {
      async transcribe() {
        await sessions.end(liveSession); // the person hits end while the provider is still transcribing
        return { ok: true, text: 'حلل الصرف' };
      },
      async speak() {
        return { ok: true, body: new ArrayBuffer(8), contentType: 'audio/mpeg' };
      },
    },
  });
  const opened = (await startVoiceSession(deps)) as unknown as { json: { session_id: string; session_token: string } };
  liveSession = opened.json.session_id;
  const heard = (await transcribeVoiceTurn(deps, upload(opened.json.session_token))) as unknown as { json: { text: string; ticket: string } };
  assert.ok(heard.json.ticket);
  assert.deepEqual(await verifyChatVoiceTicket(deps, 'user-1', heard.json.ticket, heard.json.text), { ok: false, status: 401, error: 'session_ended' });
});

test('storage down fails closed before the provider on every voice entry', async () => {
  const broken: VoiceDeps['sessions'] = {
    async isEnded() {
      throw new Error('down');
    },
    async end() {
      throw new Error('down');
    },
  };
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const { text, ticket } = await liveTurn(deps);
  const down = { ...deps, sessions: broken };
  assert.equal(((await transcribeVoiceTurn(down, upload(token))) as unknown as { status: number }).status, 503);
  assert.equal(((await endVoiceSession(down, { sessionToken: token })) as unknown as { status: number }).status, 503);
  assert.deepEqual(await verifyChatVoiceTicket(down, 'user-1', ticket, text), { ok: false, status: 503, error: 'security_service_unavailable' });
  const grant = grantSpeech(deps, 'user-1', { ticketId: 't', sessionId: 's', accountKey: '-' }, 'رد قصير')!;
  assert.equal(((await speakT(down, { ticket: grant.speak_ticket, text: grant.spoken_text })) as unknown as { status: number }).status, 503);
  assert.equal(counters.tts, 0);
});

test('the end marker is read from the same shared table the limiter writes, without consuming it', async () => {
  const NOW_MS = Date.parse('2026-10-09T12:00:00Z');
  const row = (startOffsetSec: number, count: number) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { window_start: new Date(NOW_MS - startOffsetSec * 1000).toISOString(), request_count: count }, error: null }) }) }) }),
  });
  const peek = (client: unknown) => peekRateLimitWindow({ scope: 'voice_end', identifier: 'sid', windowSeconds: 1200, client, nowMs: NOW_MS });
  assert.deepEqual(await peek(row(60, 1)), { count: 1 });
  assert.deepEqual(await peek(row(1300, 1)), { count: 0 }, 'an expired window is not an ended call');
  const empty = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
  assert.deepEqual(await peek(empty), { count: 0 });
  const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'x' } }) }) }) }) };
  await assert.rejects(() => peek(broken), /rate_limit_unavailable/);

  const store = readFileSync('lib/ai/voice-route-deps.ts', 'utf8');
  assert.ok(store.includes("scope: 'voice_end'") && store.match(/scope: 'voice_end'/g)!.length === 2, 'write and read share one scope');
  assert.ok(store.includes('endMarkerWindowSeconds(config)'));
});

test('wiring: every voice entry passes the account, the browser tells the server when the call ends', () => {
  for (const f of ['transcribe', 'speak']) {
    const route = readFileSync(`app/api/voice/${f}/route.ts`, 'utf8');
    assert.ok(route.includes('resolveVoiceAccountKey(') && route.includes('accountKey'), `${f} must resolve the account`);
  }
  assert.ok(readFileSync('app/api/voice/end/route.ts', 'utf8').includes('endVoiceSession('));
  const chat = readFileSync('app/api/chat/start/route.ts', 'utf8');
  assert.ok(chat.includes('voiceSessionStore('));
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  const end = panel.slice(panel.indexOf('const endCall'), panel.indexOf('// Hard ceiling'));
  assert.ok(end.includes('endOnServer()') && end.includes('abortRef.current?.abort()'));
  assert.ok(panel.includes("'/api/voice/end'") && panel.includes("'pagehide'") && panel.includes('keepalive: true'));
});

function ticketIdOf(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).i as string;
}

// ------------------------------------------- audio length is enforced on the server

test('audio length: a long clip is refused on the bytes before any provider request, a short one passes', async () => {
  const { deps, counters } = makeDeps();
  const send = async (audio: ArrayBuffer) => {
    const token = await openSession(deps);
    const r = (await transcribeVoiceTurn(deps, upload(token, { readAudio: async () => audio, declaredBytes: audio.byteLength }))) as unknown as { status: number; json: { error?: string } };
    return [r.status, r.json.error];
  };
  const max = deps.config.caps.maxAudioSeconds; // 30 by default
  assert.deepEqual(await send(wavOf(max)), [200, undefined]);
  assert.equal(counters.stt, 1);
  // 45 s of 16 kHz PCM is 1.44 MB: under the byte cap, over the length cap.
  const long = wavOf(max + 15);
  assert.ok(long.byteLength < deps.config.caps.maxAudioBytes, 'the size cap alone would let this through');
  assert.deepEqual(await send(long), [413, 'audio_too_large']);
  assert.equal(counters.stt, 1, 'the provider was never called for the long clip');
});

test('audio length cannot be faked: header sizes must match the payload, and only 16-bit mono PCM is accepted', () => {
  const ok = wavOf(1);
  assert.deepEqual(inspectWav(ok), { ok: true, seconds: 1, sampleRate: 16_000 });
  // A header that claims 1 s over a 30 s payload.
  const lying = wavOf(30);
  new DataView(lying).setUint32(40, 32_000, true);
  assert.equal(inspectWav(lying).ok, false);
  // Trailing bytes after the declared data are not tolerated.
  const padded = new Uint8Array(ok.byteLength + 500);
  padded.set(new Uint8Array(ok));
  assert.equal(inspectWav(padded.buffer).ok, false);
  // Stereo, 8-bit, non-PCM, garbage, empty.
  for (const [offset, size, value] of [[22, 2, 2], [34, 2, 8], [20, 2, 3]] as const) {
    const bad = wavOf(1);
    const v = new DataView(bad);
    v.setUint16(offset, value, true);
    assert.equal(inspectWav(bad).ok, false, `field at ${offset}/${size}`);
  }
  assert.equal(inspectWav(new ArrayBuffer(10_000)).ok, false);
  assert.equal(inspectWav(new ArrayBuffer(0)).ok, false);
});

test('encoder: browser sample rates are cut to 16 kHz and the capture stops at its ceiling', () => {
  const tone = (rate: number, seconds: number) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5);
  for (const rate of [44_100, 48_000]) {
    const info = inspectWav(encodeWav16([tone(rate, 2)], rate));
    assert.ok(info.ok && Math.abs(info.seconds - 2) < 0.01 && info.sampleRate === 16_000, `rate ${rate}`);
  }
  const capture = new PcmCapture(48_000, 3);
  for (let i = 0; i < 100; i++) capture.push(tone(48_000, 0.5)); // 50 s offered
  assert.ok(capture.seconds <= 3 + 1e-9);
  const info = inspectWav(capture.toWav());
  assert.ok(info.ok && info.seconds <= 3.01);
  // Chunk boundaries do not drop samples.
  const split = encodeWav16([tone(16_000, 0.3), tone(16_000, 0.7)], 16_000);
  assert.ok((inspectWav(split) as { seconds: number }).seconds === 1);
});

// ------------------------------------------- session quota window (SQL-accurate)

/**
 * Same rules as public.consume_rate_limit: a counter restarts when
 * window_start + window_seconds has passed, measured from the window of THIS
 * call. A count map would hide the bug this test is for.
 */
function makeSqlLimiter(now: () => number) {
  const rows = new Map<string, { start: number; count: number }>();
  return async (key: string, limit: number, windowSeconds: number) => {
    const t = now();
    const row = rows.get(key);
    if (!row) rows.set(key, { start: t, count: 1 });
    else if (row.start + windowSeconds * 1000 <= t) {
      row.start = t;
      row.count = 1;
    } else row.count += 1;
    return { allowed: rows.get(key)!.count <= limit, retryAfterSeconds: 30 };
  };
}

test('session turn cap holds for the whole call: reached at t=0, still reached at t=400 of 600, and at t=599', async () => {
  let t = NOW;
  const config = readVoiceConfig({
    VOICE_ASSISTANT_ENABLED: 'true',
    ELEVENLABS_API_KEY: 'k',
    ELEVENLABS_VOICE_ID: 'v',
    VOICE_TICKET_SECRET: SECRET,
    VOICE_SESSION_MAX_TURNS: '2',
  });
  assert.equal(config.caps.sessionMaxSeconds, 600);
  const { deps, counters } = makeDeps({ config, nowMs: () => t });
  deps.limit = makeSqlLimiter(() => t);
  const token = await openSession(deps);
  const turn = async () => ((await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number }).status;

  assert.equal(await turn(), 200); // t = 0
  assert.equal(await turn(), 200);
  t = NOW + 400_000;
  assert.equal(await turn(), 429, 'the cap must not reset after the artificial window of the remaining time ends');
  t = NOW + 599_000;
  assert.equal(await turn(), 429);
  assert.equal(counters.stt, 2);
  t = NOW + 601_000;
  assert.equal(await turn(), 401, 'past the session lifetime the token itself is gone');
});

test('session turn cap: the second turn late in the call counts against the first one early on', async () => {
  let t = NOW;
  const config = readVoiceConfig({
    VOICE_ASSISTANT_ENABLED: 'true',
    ELEVENLABS_API_KEY: 'k',
    ELEVENLABS_VOICE_ID: 'v',
    VOICE_TICKET_SECRET: SECRET,
    VOICE_SESSION_MAX_TURNS: '2',
  });
  const { deps, counters } = makeDeps({ config, nowMs: () => t });
  deps.limit = makeSqlLimiter(() => t);
  const token = await openSession(deps);
  const turn = async () => ((await transcribeVoiceTurn(deps, upload(token))) as unknown as { status: number }).status;
  assert.equal(await turn(), 200); // t = 0
  t = NOW + 400_000;
  assert.equal(await turn(), 200); // t = 400
  t = NOW + 401_000;
  assert.equal(await turn(), 429);
  assert.equal(counters.stt, 2);
});

test('every window used by the voice counters is fixed per key, never derived from time left', () => {
  const src = readFileSync('lib/ai/voice-server.ts', 'utf8');
  assert.ok(!/remainingSeconds/.test(src), 'a shrinking window resets the counter mid-call');
  assert.ok(src.includes('caps.sessionMaxSeconds, \'session_limit\''));
});

// ------------------------------------------- merge with main (PR59 free-audit exhaustion)

test('merge: a spoken ask with free audits used up gets a speakable subscribe offer, never an approval or a 402 dead end', async () => {
  const { planTurn } = await import('../lib/chat-first/orchestrator');
  const { prepareSpokenText } = await import('../lib/ai/voice-session');
  const state: any = {
    accountLinked: true,
    accountName: 'متجر الأمل',
    customerId: '1234567890',
    latestAudit: { id: 'a1', healthScore: 62, findingsCount: 7, estimatedMonthlyWaste: 340, ranAt: '2026-10-08T10:00:00Z' },
    recommendations: [],
    subscriptionActive: false,
    freeAudit: 'exhausted',
  };
  for (const said of ['حلل حسابي', 'ابي فحص جديد']) {
    const turn = planTurn(said, state);
    const types = turn.actions.map((a) => a.action.type);
    assert.ok(!types.includes('approve') && !types.includes('execute'), `${said}: ${types.join(',')}`);
    assert.ok(prepareSpokenText(turn.reply).length > 0, 'the reply can be spoken');
  }
});
