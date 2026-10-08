/**
 * Voice call layer for the assistant. Pure logic only: no network, no DOM.
 *
 * The call is a thin transport over the SAME chat endpoint the text assistant
 * uses (`/api/chat/assistant`). It owns the call state, how a written answer
 * is turned into something worth reading aloud, and the limits that keep a
 * call from running up cost. It never decides anything about a campaign.
 */

export type VoiceCallState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'ended'
  | 'text_fallback';

export type VoiceCallEvent =
  | 'start_listening'
  | 'speech_final'
  | 'reply_ready'
  | 'audio_started'
  | 'audio_finished'
  | 'barge_in'
  | 'stop_listening'
  | 'end_call'
  | 'fail';

/** Every transition the UI may take. Anything else is ignored, never thrown. */
const TRANSITIONS: Record<VoiceCallState, Partial<Record<VoiceCallEvent, VoiceCallState>>> = {
  idle: { start_listening: 'listening', end_call: 'ended', fail: 'text_fallback' },
  listening: {
    speech_final: 'thinking',
    stop_listening: 'idle',
    end_call: 'ended',
    fail: 'text_fallback',
  },
  thinking: { reply_ready: 'speaking', end_call: 'ended', fail: 'text_fallback' },
  speaking: {
    audio_finished: 'idle',
    // Cutting the reply short hands the floor back to the person. The mic is
    // still only opened by their tap, so this lands on `idle`, not `listening`.
    barge_in: 'idle',
    end_call: 'ended',
    fail: 'text_fallback',
  },
  ended: {},
  text_fallback: { start_listening: 'listening', end_call: 'ended' },
};

export function nextVoiceCallState(state: VoiceCallState, event: VoiceCallEvent): VoiceCallState {
  return TRANSITIONS[state][event] ?? state;
}

export const VOICE_LIMITS = {
  /** One TTS request. Longer answers are shortened for speech, never cut mid-word. */
  maxSpokenChars: 600,
  /** A call that outlives this ends itself so a forgotten tab stops costing. */
  maxCallMs: 10 * 60_000,
  /** No turn for this long and the call ends. */
  idleTimeoutMs: 90_000,
  /** TTS requests allowed per user per window. */
  ttsRequestsPerWindow: 40,
  ttsWindowSeconds: 600,
} as const;

/**
 * Turns the written answer into the text that is spoken. The screen keeps the
 * full answer; the voice reads a short, clean version of it.
 */
export function prepareSpokenText(raw: string, maxChars: number = VOICE_LIMITS.maxSpokenChars): string {
  let text = String(raw ?? '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  text = text.replace(/^\s*[-*•]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  text = text.replace(/[*_~>|]/g, ' ');
  // Dashes read as silence or a stutter in TTS. A comma gives a natural pause.
  text = text.replace(/[—–]/g, '،');
  text = text.replace(/\s*\n+\s*/g, '. ');
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length <= maxChars) return text;

  // Keep whole sentences until the budget is spent.
  const sentences = text.split(/(?<=[.!؟?])\s+/);
  let out = '';
  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (out) return out;
  // One enormous sentence: cut at the last space before the limit.
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Words that sound like consent. The voice layer treats them as ordinary
 * speech and NEVER as an approval. Applying a campaign change needs a tap on a
 * visible button in the approval center, because a transcript of "تمام" can
 * mean "I heard you", "go on", or "yes, do it", and the engine cannot tell.
 */
const CONSENT_LIKE = [
  'تمام',
  'ابشر',
  'أبشر',
  'نعم',
  'ايوه',
  'أيوه',
  'اي',
  'إي',
  'وافق',
  'موافق',
  'نفذ',
  'نفّذ',
  'طبق',
  'طبّق',
  'اعتمد',
  'ماشي',
  'اوكي',
  'أوكي',
  'ok',
  'okay',
  'yes',
];

export function looksLikeVoiceApproval(transcript: string): boolean {
  const normalized = String(transcript ?? '')
    .toLowerCase()
    .replace(/[.,!؟?،]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const words = normalized.split(' ');
  return words.some((word) => CONSENT_LIKE.includes(word));
}

export const VOICE_APPROVAL_NOTICE =
  'التنفيذ ما يصير بالصوت. افتح مركز الموافقات، راجع المعاينة، واضغط زر الموافقة بنفسك.';

export type TtsRequestCheck = { ok: true; text: string } | { ok: false; status: number; error: string };

/** Server-side validation of the text sent to the TTS route. */
export function validateTtsText(input: unknown): TtsRequestCheck {
  if (typeof input !== 'string') return { ok: false, status: 400, error: 'invalid_text' };
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, status: 400, error: 'empty_text' };
  if (text.length > VOICE_LIMITS.maxSpokenChars) {
    return { ok: false, status: 413, error: 'text_too_long' };
  }
  return { ok: true, text };
}

export type VoiceConfig = {
  enabled: boolean;
  apiKey: string | null;
  voiceId: string | null;
  modelId: string;
};

/** Default is Fahad (library voice, Saudi Arabic). Never a cloned voice. */
export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5';

export function readVoiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig {
  const flag = (env.VOICE_ASSISTANT_ENABLED ?? '').trim().toLowerCase();
  const apiKey = env.ELEVENLABS_API_KEY?.trim() || null;
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || null;
  return {
    // All three must exist. A flag with no key must read as "off", not crash.
    enabled: flag === 'true' && Boolean(apiKey) && Boolean(voiceId),
    apiKey,
    voiceId,
    modelId: env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_VOICE_MODEL,
  };
}

/** Arabic error text for the three ways the TTS leg can fail. */
export function ttsFailureMessage(status: number | null): string {
  if (status === 401 || status === 403) return 'الصوت غير متاح لحسابك الآن. الرد مكتوب فوق.';
  if (status === 429) return 'وصلت حد الرد الصوتي مؤقتاً. كمّل كتابة وأرجع بعد قليل.';
  if (status === null) return 'انقطع الاتصال أثناء تشغيل الصوت. الرد مكتوب فوق.';
  return 'تعذر تشغيل الصوت. الرد مكتوب فوق وتقدر تكمل كتابة.';
}
