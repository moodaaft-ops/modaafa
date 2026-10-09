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
  thinking: { reply_ready: 'speaking', stop_listening: 'idle', end_call: 'ended', fail: 'text_fallback' },
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

export type VoiceProviderKind = 'elevenlabs' | 'mock';

export type VoiceConfig = {
  enabled: boolean;
  provider: VoiceProviderKind;
  apiKey: string | null;
  voiceId: string | null;
  modelId: string;
  sttModelId: string;
  ticketSecret: string | null;
  /** Daily voice turns for signed-in users without a subscription. 0 closes voice to them. */
  freeDailyTurns: number;
  caps: VoiceCaps;
};

export type VoiceCaps = {
  /** Turns (one spoken question and its spoken answer) in one call. */
  sessionMaxTurns: number;
  /** Wall-clock life of one call, in seconds. */
  sessionMaxSeconds: number;
  /** Turns per user per day. Never above the plan's daily assistant quota. */
  dailyTurns: number;
  /** One recorded question. */
  maxAudioBytes: number;
  maxAudioSeconds: number;
  maxSpokenChars: number;
};

/** Default is Fahad (library voice, Saudi Arabic). Never a cloned voice. */
export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5';
export const DEFAULT_STT_MODEL = 'scribe_v2';

function intFrom(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Caps are env-tunable but clamped, and the daily cap can never exceed the
 * plan's daily assistant quota: every voice turn also spends one assistant
 * message through the chat endpoint, so a bigger voice number would be fiction.
 */
export function resolveVoiceCaps(
  env: Record<string, string | undefined> = process.env,
  planAssistantDailyLimit: number | null = null
): VoiceCaps {
  const dailyEnv = intFrom(env.VOICE_DAILY_TURNS, 30, 1, 500);
  return {
    sessionMaxTurns: intFrom(env.VOICE_SESSION_MAX_TURNS, 12, 1, 60),
    sessionMaxSeconds: intFrom(env.VOICE_SESSION_MAX_SECONDS, 600, 60, 3600),
    dailyTurns: planAssistantDailyLimit ? Math.min(dailyEnv, planAssistantDailyLimit) : dailyEnv,
    maxAudioBytes: intFrom(env.VOICE_MAX_AUDIO_BYTES, 1_500_000, 20_000, 5_000_000),
    maxAudioSeconds: intFrom(env.VOICE_MAX_AUDIO_SECONDS, 30, 5, 60),
    maxSpokenChars: VOICE_LIMITS.maxSpokenChars,
  };
}

export function readVoiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig {
  const flag = (env.VOICE_ASSISTANT_ENABLED ?? '').trim().toLowerCase();
  const apiKey = env.ELEVENLABS_API_KEY?.trim() || null;
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || null;
  const secret = env.VOICE_TICKET_SECRET?.trim() || null;
  const wantsMock = (env.VOICE_PROVIDER ?? '').trim().toLowerCase() === 'mock';
  // The mock provider exists so the whole flow can be tried on a phone without
  // a provider key. It must be impossible to run it on production.
  const mockAllowed = wantsMock && env.VERCEL_ENV !== 'production';
  const provider: VoiceProviderKind = mockAllowed ? 'mock' : 'elevenlabs';
  const providerReady = provider === 'mock' || (Boolean(apiKey) && Boolean(voiceId));
  const secretReady = Boolean(secret) && (secret as string).length >= 32;
  return {
    // Flag, a real signing secret and a usable provider. Anything less reads
    // as "off" rather than half working. `VOICE_PROVIDER=mock` on production
    // also reads as off, never as a silent switch to the paid provider.
    enabled: flag === 'true' && secretReady && providerReady && !(wantsMock && !mockAllowed),
    provider,
    apiKey,
    voiceId,
    modelId: env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_VOICE_MODEL,
    sttModelId: env.ELEVENLABS_STT_MODEL_ID?.trim() || DEFAULT_STT_MODEL,
    ticketSecret: secret,
    freeDailyTurns: intFrom(env.VOICE_FREE_DAILY_TURNS, 3, 0, 20),
    caps: resolveVoiceCaps(env),
  };
}

/** Recorder formats in the order we prefer them. Safari/iOS only has mp4. */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      /* some engines throw on unknown types */
    }
  }
  return null;
}

/** Below this the recording is almost certainly silence or a mis-tap. */
export const MIN_RECORDING_BYTES = 1500;

export type VoiceErrorCode =
  | 'voice_unavailable'
  | 'unauthorized'
  | 'subscription_required'
  | 'session_expired'
  | 'session_ended'
  | 'session_limit'
  | 'daily_limit'
  | 'too_many_requests'
  | 'audio_too_large'
  | 'unsupported_audio'
  | 'no_speech'
  | 'ticket_invalid'
  | 'account_changed'
  | 'account_not_found'
  | 'text_too_long'
  | 'voice_plan_required'
  | 'provider_failed'
  | 'security_service_unavailable';

export function voiceErrorMessage(code: string | undefined, status: number | null): string {
  switch (code) {
    case 'voice_unavailable':
      return 'المكالمة الصوتية غير مفعّلة الآن. كمّل كتابة.';
    case 'subscription_required':
      return 'المكالمة الصوتية تحتاج اشتراكاً فعّالاً. كمّل كتابة.';
    case 'session_expired':
    case 'unauthorized':
      return 'انتهت جلسة المكالمة. اضغط التحدث لبدء جلسة جديدة.';
    case 'session_limit':
      return 'وصلت حد هذه المكالمة. ابدأ مكالمة جديدة أو كمّل كتابة.';
    case 'daily_limit':
      return 'وصلت حد المكالمات الصوتية اليوم. كمّل كتابة وارجع بكرة.';
    case 'too_many_requests':
      return 'طلبات كثيرة بسرعة. انتظر قليلاً وأعد المحاولة.';
    case 'audio_too_large':
      return 'التسجيل طويل. قصّر سؤالك وأعد المحاولة.';
    case 'unsupported_audio':
      return 'متصفحك سجّل الصوت بصيغة غير مدعومة. كمّل كتابة.';
    case 'no_speech':
      return 'لم أسمع كلاماً واضحاً. اضغط التحدث وأعد المحاولة.';
    case 'voice_plan_required':
      return 'الصوت المختار غير متاح على خطة مزود الصوت. الرد مكتوب فوق.';
    case 'session_ended':
      return 'انتهت هذي المكالمة. ابدأ مكالمة جديدة لو تبي تكمل.';
    case 'account_changed':
      return 'تغيّر الحساب الإعلاني أثناء المكالمة، فانتهت. ابدأ مكالمة جديدة على الحساب الحالي.';
    case 'account_not_found':
      return 'ما لقيت هذا الحساب ضمن حساباتك. اختر حسابك وابدأ مكالمة جديدة.';
    case 'ticket_invalid':
      return 'تعذر تشغيل الرد صوتياً. الرد مكتوب فوق.';
    default:
      return ttsFailureMessage(status);
  }
}

/** Arabic error text for the three ways the TTS leg can fail. */
export function ttsFailureMessage(status: number | null): string {
  if (status === 401 || status === 403) return 'الصوت غير متاح لحسابك الآن. الرد مكتوب فوق.';
  if (status === 429) return 'وصلت حد الرد الصوتي مؤقتاً. كمّل كتابة وأرجع بعد قليل.';
  if (status === null) return 'انقطع الاتصال أثناء تشغيل الصوت. الرد مكتوب فوق.';
  return 'تعذر تشغيل الصوت. الرد مكتوب فوق وتقدر تكمل كتابة.';
}
