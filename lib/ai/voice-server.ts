import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  prepareSpokenText,
  validateTtsText,
  type VoiceCaps,
  type VoiceConfig,
  type VoiceErrorCode,
} from './voice-session';

/**
 * Server side of the voice call. Everything that decides "may this request
 * reach the paid provider" lives here, with its dependencies injected, so the
 * routes are thin and the gates are testable without Supabase or a provider.
 *
 * Gate order for every paid call: flag, signed token, user match, expiry,
 * per-session cap, per-user daily cap, size, then the provider. A request that
 * fails any gate never reaches the provider.
 */

export type VoiceTokenPayload = {
  /** session | turn (one transcribed question) | speak (one chat reply, bound by hash) */
  k: 'session' | 'turn' | 'speak';
  /** user id */
  u: string;
  /** session id */
  s: string;
  /** unique id (the single-use handle of a turn ticket) */
  i: string;
  /** expiry, epoch seconds */
  e: number;
  /** sha256 of the text this token is bound to (turn: the question, speak: the spoken reply) */
  h?: string;
};

/** Same normalisation on both sides of every hash comparison. */
export function textFingerprint(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim(), 'utf8').digest('base64url');
}

const b64 = (buf: Buffer) => buf.toString('base64url');

export function signVoiceToken(payload: VoiceTokenPayload, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyVoiceToken(
  token: string | null | undefined,
  secret: string,
  expected: { kind: VoiceTokenPayload['k']; userId: string; sessionId?: string },
  nowMs: number
): VoiceTokenPayload | null {
  if (!token || token.length > 1024) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let payload: VoiceTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.k !== expected.kind) return null;
  if (typeof payload.u !== 'string' || payload.u !== expected.userId) return null;
  if (expected.sessionId && payload.s !== expected.sessionId) return null;
  if (typeof payload.e !== 'number' || payload.e * 1000 <= nowMs) return null;
  return payload;
}

export type LimitResult = { allowed: boolean; retryAfterSeconds?: number };

export type VoiceProvider = {
  transcribe(audio: ArrayBuffer, mime: string): Promise<{ ok: true; text: string } | { ok: false; status: number }>;
  speak(text: string, signal?: AbortSignal): Promise<{ ok: true; body: ReadableStream<Uint8Array> | ArrayBuffer; contentType: string } | { ok: false; status: number }>;
};

export type VoiceDeps = {
  config: VoiceConfig;
  nowMs: () => number;
  /** null when the caller is not signed in. */
  user: { id: string; email: string | null } | null;
  /** Active plan's daily assistant quota, or null when there is no live subscription. */
  planAssistantDailyLimit: number | null;
  /** Which entitlement produced the limit above. */
  tier: 'paid' | 'free' | null;
  /** Rate limiter. Throws when storage is down; handlers turn that into 503. */
  limit: (key: string, limit: number, windowSeconds: number) => Promise<LimitResult>;
  provider: VoiceProvider;
};

export type VoiceResult =
  | { status: number; json: Record<string, unknown> & { error?: VoiceErrorCode } }
  | { status: 200; audio: { body: ReadableStream<Uint8Array> | ArrayBuffer; contentType: string } };

const fail = (status: number, error: VoiceErrorCode, extra: Record<string, unknown> = {}): VoiceResult => ({
  status,
  json: { error, ...extra },
});

async function guarded(
  deps: VoiceDeps,
  checks: Array<[string, number, number, VoiceErrorCode]>
): Promise<VoiceResult | null> {
  for (const [key, limit, windowSeconds, code] of checks) {
    let result: LimitResult;
    try {
      result = await deps.limit(key, limit, windowSeconds);
    } catch {
      return fail(503, 'security_service_unavailable');
    }
    if (!result.allowed) return fail(429, code, { retry_after: result.retryAfterSeconds ?? null });
  }
  return null;
}

function preflight(deps: VoiceDeps): VoiceResult | null {
  // Off means off: same answer whether the flag, the secret or the provider is missing.
  if (!deps.config.enabled || !deps.config.ticketSecret) return fail(404, 'voice_unavailable');
  if (!deps.user) return fail(401, 'unauthorized');
  return null;
}

/** POST /api/voice/session: opens a call. No provider is touched. */
export async function startVoiceSession(deps: VoiceDeps): Promise<VoiceResult> {
  const early = preflight(deps);
  if (early) return early;
  if (!deps.planAssistantDailyLimit) return fail(402, 'subscription_required');

  const user = deps.user!;
  const caps: VoiceCaps = capsForPlan(deps.config.caps, deps.planAssistantDailyLimit);
  const blocked = await guarded(deps, [[`voice_start:${user.id}`, 10, 600, 'too_many_requests']]);
  if (blocked) return blocked;

  const now = deps.nowMs();
  const sessionId = b64(randomBytes(12));
  const expires = Math.floor(now / 1000) + caps.sessionMaxSeconds;
  const token = signVoiceToken(
    { k: 'session', u: user.id, s: sessionId, i: sessionId, e: expires },
    deps.config.ticketSecret!
  );
  return {
    status: 200,
    json: {
      session_token: token,
      session_id: sessionId,
      expires_at: new Date(expires * 1000).toISOString(),
      provider: deps.config.provider,
      tier: deps.tier,
      caps: {
        session_max_turns: caps.sessionMaxTurns,
        session_max_seconds: caps.sessionMaxSeconds,
        daily_turns: caps.dailyTurns,
        max_audio_seconds: caps.maxAudioSeconds,
        max_spoken_chars: caps.maxSpokenChars,
      },
    },
  };
}

/** Config caps with the daily number clamped to the plan's assistant quota. */
export function capsForPlan(caps: VoiceCaps, planAssistantDailyLimit: number): VoiceCaps {
  return { ...caps, dailyTurns: Math.max(1, Math.min(caps.dailyTurns, planAssistantDailyLimit)) };
}

const ALLOWED_AUDIO = /^audio\/(webm|mp4|ogg|mpeg|wav|x-m4a|aac)(;.*)?$/i;

/** POST /api/voice/transcribe: one recorded question in, text and a turn ticket out. */
export async function transcribeVoiceTurn(
  deps: VoiceDeps,
  input: { sessionToken: string | null; mime: string; readAudio: () => Promise<ArrayBuffer | null>; declaredBytes: number | null }
): Promise<VoiceResult> {
  const early = preflight(deps);
  if (early) return early;
  if (!deps.planAssistantDailyLimit) return fail(402, 'subscription_required');

  const user = deps.user!;
  const secret = deps.config.ticketSecret!;
  const now = deps.nowMs();
  const session = verifyVoiceToken(input.sessionToken, secret, { kind: 'session', userId: user.id }, now);
  if (!session) return fail(401, 'session_expired');

  const caps = capsForPlan(deps.config.caps, deps.planAssistantDailyLimit);

  if (!ALLOWED_AUDIO.test(input.mime || '')) return fail(415, 'unsupported_audio');
  // Reject on the declared size before the body is read into memory, then on
  // the real size, because a header is only a claim.
  if (input.declaredBytes !== null && input.declaredBytes > caps.maxAudioBytes) return fail(413, 'audio_too_large');
  const remainingSeconds = Math.max(1, session.e - Math.floor(now / 1000));
  const blocked = await guarded(deps, [
    [`voice_turns_s:${session.s}`, caps.sessionMaxTurns, Math.min(remainingSeconds, caps.sessionMaxSeconds), 'session_limit'],
    [`voice_turns_d:${user.id}`, caps.dailyTurns, 86_400, 'daily_limit'],
  ]);
  if (blocked) return blocked;

  // Body is read only after every cheap gate has passed.
  const audio = await input.readAudio();
  if (!audio || audio.byteLength === 0) return fail(422, 'no_speech');
  if (audio.byteLength > caps.maxAudioBytes) return fail(413, 'audio_too_large');

  const result = await deps.provider.transcribe(audio, input.mime);
  if (!result.ok) {
    return fail(result.status === 402 || result.status === 401 || result.status === 403 ? 503 : 502, 'provider_failed');
  }
  const text = result.text.replace(/\s+/g, ' ').trim();
  if (!text) return fail(422, 'no_speech');

  const ticketId = b64(randomBytes(12));
  const finalText = text.slice(0, 4000);
  const ticket = signVoiceToken(
    { k: 'turn', u: user.id, s: session.s, i: ticketId, e: Math.floor(now / 1000) + 180, h: textFingerprint(finalText) },
    secret
  );
  return { status: 200, json: { text: finalText, ticket } };
}

/** POST /api/voice/speak: text to audio, only for a reply the chat route itself granted. */
export async function speakVoiceTurn(
  deps: VoiceDeps,
  input: { ticket: string | null; text: unknown; signal?: AbortSignal }
): Promise<VoiceResult> {
  const early = preflight(deps);
  if (early) return early;
  if (!deps.planAssistantDailyLimit) return fail(402, 'subscription_required');

  const user = deps.user!;
  const now = deps.nowMs();
  const ticket = verifyVoiceToken(input.ticket, deps.config.ticketSecret!, { kind: 'speak', userId: user.id }, now);
  if (!ticket) return fail(403, 'ticket_invalid');

  const checked = validateTtsText(input.text);
  if (!checked.ok) {
    return fail(checked.status, checked.error === 'text_too_long' ? 'text_too_long' : 'ticket_invalid');
  }

  // The ticket is bound to the exact spoken text the chat route produced.
  // Anything else, however well formed, is refused before the provider.
  if (!ticket.h || textFingerprint(checked.text) !== ticket.h) return fail(403, 'ticket_invalid');

  // A ticket buys at most two playbacks: the second is there for one retry
  // after a dropped connection, not for replaying audio.
  const blocked = await guarded(deps, [[`voice_ticket:${ticket.i}`, 2, 300, 'ticket_invalid']]);
  if (blocked) return blocked.status === 429 ? fail(403, 'ticket_invalid') : blocked;

  const result = await deps.provider.speak(checked.text, input.signal);
  if (!result.ok) {
    if (result.status === 402) return fail(503, 'voice_plan_required');
    return fail(result.status === 429 ? 429 : 502, 'provider_failed');
  }
  return { status: 200, audio: { body: result.body, contentType: result.contentType } };
}

// ---------------------------------------------------------------- providers

export function createElevenLabsProvider(config: VoiceConfig, fetchImpl: typeof fetch = fetch): VoiceProvider {
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append('model_id', config.sttModelId);
      form.append('language_code', 'ar');
      form.append('tag_audio_events', 'false');
      form.append('file', new Blob([audio], { type: mime.split(';')[0] }), `turn.${mimeExtension(mime)}`);
      let response: Response;
      try {
        response = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: { 'xi-api-key': config.apiKey as string },
          body: form,
        });
      } catch {
        return { ok: false, status: 502 };
      }
      if (!response.ok) return { ok: false, status: response.status };
      const data = (await response.json().catch(() => ({}))) as { text?: unknown };
      return { ok: true, text: typeof data.text === 'string' ? data.text : '' };
    },
    async speak(text, signal) {
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId as string)}/stream?output_format=mp3_44100_64`,
          {
            method: 'POST',
            headers: { 'xi-api-key': config.apiKey as string, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: config.modelId, language_code: 'ar' }),
            signal,
          }
        );
      } catch {
        return { ok: false, status: 502 };
      }
      if (!response.ok || !response.body) return { ok: false, status: response.status || 502 };
      return { ok: true, body: response.body, contentType: 'audio/mpeg' };
    },
  };
}

function mimeExtension(mime: string) {
  if (/mp4|m4a|aac/i.test(mime)) return 'm4a';
  if (/ogg/i.test(mime)) return 'ogg';
  if (/wav/i.test(mime)) return 'wav';
  if (/mpeg/i.test(mime)) return 'mp3';
  return 'webm';
}

/**
 * Stand-in provider for trying the whole flow on a phone without a provider
 * key. `readVoiceConfig` refuses it on production. The transcript is fixed (or
 * VOICE_MOCK_TRANSCRIPT), the audio is a short two-tone beep, so a human can
 * tell the loop works end to end but nobody mistakes it for the real voice.
 */
export function createMockProvider(transcript = 'حلل الصرف آخر سبعة أيام'): VoiceProvider {
  return {
    async transcribe(audio) {
      // Proves a real recording arrived, instead of echoing blindly.
      return audio.byteLength < 1500 ? { ok: true, text: '' } : { ok: true, text: transcript };
    },
    async speak() {
      return { ok: true, body: makeBeepWav(), contentType: 'audio/wav' };
    },
  };
}

export function makeBeepWav(): ArrayBuffer {
  const rate = 16_000;
  const tones = [660, 880];
  const perTone = Math.floor(rate * 0.35);
  const samples = perTone * tones.length;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  let offset = 44;
  tones.forEach((hz) => {
    for (let n = 0; n < perTone; n++) {
      const fade = Math.min(1, n / 400, (perTone - n) / 400);
      v.setInt16(offset, Math.round(Math.sin((2 * Math.PI * hz * n) / rate) * 9000 * fade), true);
      offset += 2;
    }
  });
  return buffer;
}

// ------------------------------------------------- chat route integration

export type ChatVoiceCheck =
  | { ok: true; ticketId: string; sessionId: string }
  | { ok: false; status: number; error: VoiceErrorCode };

/**
 * Called by the chat route when a request carries a voice turn ticket. The
 * ticket must belong to this user, be fresh, be bound to exactly this message,
 * and can be used for one chat call.
 */
export async function verifyChatVoiceTicket(
  deps: Pick<VoiceDeps, 'config' | 'nowMs' | 'limit'>,
  userId: string,
  ticket: string,
  message: string
): Promise<ChatVoiceCheck> {
  if (!deps.config.enabled || !deps.config.ticketSecret) return { ok: false, status: 404, error: 'voice_unavailable' };
  const payload = verifyVoiceToken(ticket, deps.config.ticketSecret, { kind: 'turn', userId }, deps.nowMs());
  if (!payload || !payload.h || payload.h !== textFingerprint(message)) {
    return { ok: false, status: 403, error: 'ticket_invalid' };
  }
  try {
    const used = await deps.limit(`voice_chat:${payload.i}`, 1, 300);
    if (!used.allowed) return { ok: false, status: 403, error: 'ticket_invalid' };
  } catch {
    return { ok: false, status: 503, error: 'security_service_unavailable' };
  }
  return { ok: true, ticketId: payload.i, sessionId: payload.s };
}

/** Turns a chat reply into the exact text to speak plus a ticket bound to it. */
export function grantSpeech(
  deps: Pick<VoiceDeps, 'config' | 'nowMs'>,
  userId: string,
  check: { ticketId: string; sessionId: string },
  replyText: string
): { spoken_text: string; speak_ticket: string } | null {
  const spoken = prepareSpokenText(replyText);
  if (!spoken || !deps.config.ticketSecret) return null;
  const speak_ticket = signVoiceToken(
    {
      k: 'speak',
      u: userId,
      s: check.sessionId,
      i: `${check.ticketId}.s`,
      e: Math.floor(deps.nowMs() / 1000) + 180,
      h: textFingerprint(spoken),
    },
    deps.config.ticketSecret
  );
  return { spoken_text: spoken, speak_ticket };
}
