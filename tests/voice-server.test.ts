import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capsForPlan,
  createMockProvider,
  grantSpeech,
  makeBeepWav,
  signVoiceToken,
  speakVoiceTurn,
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
    tier: 'paid',
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

/** What the chat route does: verify the turn ticket against the message, then grant speech for the reply. */
async function chatGrant(deps: VoiceDeps, ticket: string, message = 'حلل الصرف', reply = 'الصرف ثابت اليوم') {
  const check = await verifyChatVoiceTicket(deps, 'user-1', ticket, message);
  assert.ok(check.ok, JSON.stringify(check));
  const grant = grantSpeech(deps, 'user-1', check as { ticketId: string; sessionId: string }, reply);
  assert.ok(grant);
  return grant as { spoken_text: string; speak_ticket: string };
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
  const grant = await chatGrant(deps, heard.json.ticket);
  const spoken = await speakVoiceTurn(deps, { ticket: grant.speak_ticket, text: grant.spoken_text });
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

test('a speak ticket is single use: the third playback is refused', async () => {
  const { deps, counters } = makeDeps();
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  const grant = await chatGrant(deps, heard.json.ticket);
  const play = () => speakVoiceTurn(deps, { ticket: grant.speak_ticket, text: grant.spoken_text });
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
    assert.equal((await speakVoiceTurn(deps, { ticket: grant.speak_ticket, text })).status, 403, text);
  }
  // A turn ticket (the transcribe leg) is not a speak ticket either.
  const turn = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  assert.equal((await speakVoiceTurn(deps, { ticket: turn.json.ticket, text: grant.spoken_text })).status, 403);
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
  assert.equal((await speakVoiceTurn(deps, { ticket: old, text: 'رد' })).status, 403);
  const token = await openSession(deps);
  const heard = (await transcribeVoiceTurn(deps, upload(token))) as unknown as { json: { ticket: string } };
  const grant = await chatGrant(deps, heard.json.ticket);
  assert.equal((await speakVoiceTurn(deps, { ticket: grant.speak_ticket, text: 'ا'.repeat(601) })).status, 413);
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
  const g = await chatGrant(paid.deps, t.json.ticket);
  const spoken = (await speakVoiceTurn(paid.deps, { ticket: g.speak_ticket, text: g.spoken_text })) as unknown as { status: number; json: { error: string } };
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

import { readFileSync } from 'node:fs';

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
    const t = (await transcribeVoiceTurn(deps, upload(await open(account)))) as unknown as { json: { text: string; ticket: string } };
    return t.json;
  };
  const a = await heardOn('acct-A');
  const wrong = await verifyChatVoiceTicket(deps, 'user-1', a.ticket, a.text, 'acct-B');
  assert.deepEqual(wrong, { ok: false, status: 409, error: 'account_changed' });
  // The refused ticket was not spent by the failed check: the right account can still use it.
  assert.equal((await verifyChatVoiceTicket(deps, 'user-1', a.ticket, a.text, 'acct-A')).ok, true);
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
