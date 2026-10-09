import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_VOICE_MODEL,
  pickRecorderMime,
  resolveVoiceCaps,
  looksLikeVoiceApproval,
  nextVoiceCallState,
  prepareSpokenText,
  readVoiceConfig,
  ttsFailureMessage,
  validateTtsText,
  VOICE_LIMITS,
  type VoiceCallEvent,
  type VoiceCallState,
} from '../lib/ai/voice-session';

function run(events: VoiceCallEvent[], from: VoiceCallState = 'idle') {
  return events.reduce(nextVoiceCallState, from);
}

test('a normal turn goes listen, think, speak, back to idle', () => {
  assert.equal(run(['start_listening']), 'listening');
  assert.equal(run(['start_listening', 'speech_final']), 'thinking');
  assert.equal(run(['start_listening', 'speech_final', 'reply_ready']), 'speaking');
  assert.equal(run(['start_listening', 'speech_final', 'reply_ready', 'audio_finished']), 'idle');
});

test('cutting the reply returns to idle, so the mic is never reopened without a tap', () => {
  const afterCut = run(['start_listening', 'speech_final', 'reply_ready', 'barge_in']);
  assert.equal(afterCut, 'idle');
  assert.notEqual(afterCut, 'listening');
});

test('ending the call works from every live state and is final', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'text_fallback'] as VoiceCallState[]) {
    assert.equal(nextVoiceCallState(state, 'end_call'), 'ended');
  }
  assert.equal(run(['start_listening'], 'ended'), 'ended');
  assert.equal(run(['fail'], 'ended'), 'ended');
});

test('mic denial, network drop and TTS failure all land on text fallback', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking'] as VoiceCallState[]) {
    assert.equal(nextVoiceCallState(state, 'fail'), 'text_fallback');
  }
  // From text fallback the person can still try the mic again, by tapping.
  assert.equal(nextVoiceCallState('text_fallback', 'start_listening'), 'listening');
});

test('impossible transitions are ignored instead of thrown', () => {
  assert.equal(nextVoiceCallState('idle', 'reply_ready'), 'idle');
  assert.equal(nextVoiceCallState('listening', 'audio_finished'), 'listening');
});

test('spoken text drops markdown, bullets and dashes', () => {
  const spoken = prepareSpokenText('## الخلاصة\n- **الصرف** ارتفع — لكن التحويلات ثابتة\n1. راجع الكلمات\n[التفاصيل](https://x.y)');
  assert.ok(!/[#*\[\]()—–]/.test(spoken), spoken);
  assert.match(spoken, /الصرف ارتفع/);
  assert.match(spoken, /التفاصيل/);
});

test('long answers are cut at a sentence boundary under the limit', () => {
  const sentence = 'هذه جملة اختبار قصيرة عن أداء الحملة. ';
  const spoken = prepareSpokenText(sentence.repeat(60));
  assert.ok(spoken.length <= VOICE_LIMITS.maxSpokenChars);
  assert.ok(spoken.endsWith('.'), 'must end on a whole sentence');
});

test('one huge sentence is cut at a word, not mid-word', () => {
  const spoken = prepareSpokenText('كلمة '.repeat(400).trim(), 100);
  assert.ok(spoken.length <= 100);
  assert.ok(!spoken.endsWith('كل'));
});

test('consent words are flagged and never treated as approval', () => {
  for (const phrase of ['تمام', 'ايوه نفذها', 'موافق', 'yes', 'طبّق التعديل']) {
    assert.equal(looksLikeVoiceApproval(phrase), true, phrase);
  }
  assert.equal(looksLikeVoiceApproval('وش أهم توصية'), false);
  assert.equal(looksLikeVoiceApproval(''), false);
});

test('TTS text is validated: type, empty, and size', () => {
  assert.deepEqual(validateTtsText(42), { ok: false, status: 400, error: 'invalid_text' });
  assert.deepEqual(validateTtsText('   '), { ok: false, status: 400, error: 'empty_text' });
  const tooLong = validateTtsText('ا'.repeat(VOICE_LIMITS.maxSpokenChars + 1));
  assert.deepEqual(tooLong, { ok: false, status: 413, error: 'text_too_long' });
  assert.deepEqual(validateTtsText(' مرحبا   بك '), { ok: true, text: 'مرحبا بك' });
});

const SECRET = 'x'.repeat(40);
const base = { VOICE_ASSISTANT_ENABLED: 'true', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', VOICE_TICKET_SECRET: SECRET };

test('voice is off unless flag, signing secret and provider are all present', () => {
  assert.equal(readVoiceConfig({}).enabled, false);
  assert.equal(readVoiceConfig({ VOICE_ASSISTANT_ENABLED: 'true' }).enabled, false);
  assert.equal(readVoiceConfig({ ...base, VOICE_TICKET_SECRET: undefined }).enabled, false);
  assert.equal(readVoiceConfig({ ...base, VOICE_TICKET_SECRET: 'short' }).enabled, false);
  assert.equal(readVoiceConfig({ ...base, ELEVENLABS_API_KEY: undefined }).enabled, false);
  assert.equal(readVoiceConfig({ ...base, VOICE_ASSISTANT_ENABLED: 'false' }).enabled, false);
  const on = readVoiceConfig(base);
  assert.equal(on.enabled, true);
  assert.equal(on.provider, 'elevenlabs');
  assert.equal(on.modelId, DEFAULT_VOICE_MODEL);
});

test('the mock provider needs no key off production and reads as off on production', () => {
  const mock = { VOICE_ASSISTANT_ENABLED: 'true', VOICE_PROVIDER: 'mock', VOICE_TICKET_SECRET: SECRET };
  assert.equal(readVoiceConfig({ ...mock, VERCEL_ENV: 'preview' }).enabled, true);
  assert.equal(readVoiceConfig({ ...mock, VERCEL_ENV: 'preview' }).provider, 'mock');
  // Production never silently falls back to the paid provider either.
  const prod = readVoiceConfig({ ...mock, ...base, VOICE_PROVIDER: 'mock', VERCEL_ENV: 'production' });
  assert.equal(prod.enabled, false);
});

test('caps are tunable, clamped, and the daily cap never exceeds the plan quota', () => {
  assert.equal(resolveVoiceCaps({}, null).dailyTurns, 30);
  assert.equal(resolveVoiceCaps({ VOICE_DAILY_TURNS: '400' }, 20).dailyTurns, 20);
  assert.equal(resolveVoiceCaps({ VOICE_DAILY_TURNS: '5' }, 100).dailyTurns, 5);
  assert.equal(resolveVoiceCaps({ VOICE_SESSION_MAX_TURNS: '9999' }).sessionMaxTurns, 60);
  assert.equal(resolveVoiceCaps({ VOICE_SESSION_MAX_TURNS: 'abc' }).sessionMaxTurns, 12);
  assert.equal(resolveVoiceCaps({ VOICE_MAX_AUDIO_BYTES: '1' }).maxAudioBytes, 20_000);
});

test('recorder mime negotiation falls back to mp4 on Safari and returns null when nothing works', () => {
  assert.equal(pickRecorderMime((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickRecorderMime(() => true), 'audio/webm;codecs=opus');
  assert.equal(pickRecorderMime(() => false), null);
  assert.equal(pickRecorderMime(() => { throw new Error('x'); }), null);
});

test('failure messages tell the person the answer is still written', () => {
  assert.match(ttsFailureMessage(429), /حد الرد الصوتي/);
  assert.match(ttsFailureMessage(null), /انقطع الاتصال/);
  assert.match(ttsFailureMessage(500), /مكتوب/);
});

test('the ElevenLabs key never reaches client code', () => {
  const clientFiles = [
    'app/(dashboard)/assistant/voice-call-panel.tsx',
    'app/(dashboard)/assistant/assistant-client.tsx',
  ];
  for (const file of clientFiles) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!/ELEVENLABS_API_KEY|xi-api-key/i.test(source), `${file} must not mention the key`);
    assert.ok(!/NEXT_PUBLIC_ELEVEN/i.test(source), `${file} must not read a public key`);
  }
  assert.ok(!/NEXT_PUBLIC_ELEVEN/i.test(readFileSync('.env.example', 'utf8')));
});

test('every paid voice route checks origin first and delegates to the gated handlers', () => {
  for (const [file, handler] of [
    ['app/api/voice/session/route.ts', 'startVoiceSession'],
    ['app/api/voice/transcribe/route.ts', 'transcribeVoiceTurn'],
    ['app/api/voice/speak/route.ts', 'speakVoiceTurn'],
  ]) {
    const source = readFileSync(file, 'utf8');
    const origin = source.indexOf('isSameOriginRequest(req)');
    const call = source.indexOf(`${handler}(`);
    assert.ok(origin > -1 && call > origin, `${file}: origin check must precede ${handler}`);
    assert.ok(!/api\.elevenlabs\.io/.test(source), `${file} must not call the provider directly`);
  }
});

test('the voice path never reaches an approval or execution endpoint', () => {
  const panel = readFileSync('app/(dashboard)/assistant/voice-call-panel.tsx', 'utf8');
  assert.ok(!/\/api\/(actions|execute|recommendations|autopilot)/.test(panel));
  assert.ok(panel.includes('/api/voice/speak'));
});

test('CSP lets the browser play the blob audio and nothing wider', async () => {
  const { buildContentSecurityPolicy } = await import('../lib/security/csp');
  const media = buildContentSecurityPolicy('n').split(';').map((p) => p.trim()).find((p) => p.startsWith('media-src'));
  assert.equal(media, "media-src 'self' blob:");
});
