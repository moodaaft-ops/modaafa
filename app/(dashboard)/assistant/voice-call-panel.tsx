'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { Keyboard, LoaderCircle, Mic, PhoneOff, Square } from 'lucide-react';
import { microphoneAccessErrorMessage } from '@/lib/ai/voice-input';
import {
  looksLikeVoiceApproval,
  MIN_RECORDING_BYTES,
  nextVoiceCallState,
  pickRecorderMime,
  prepareSpokenText,
  voiceErrorMessage,
  VOICE_APPROVAL_NOTICE,
  VOICE_LIMITS,
  type VoiceCallEvent,
  type VoiceCallState,
} from '@/lib/ai/voice-session';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

export type VoiceTurnResult = { reply: string; hasDraft: boolean } | null;

const STATE_LABEL: Record<VoiceCallState, string> = {
  idle: 'اضغط الميكروفون وتكلم',
  listening: 'أسمعك...',
  thinking: 'أحلل سؤالك...',
  speaking: 'أتكلم الحين. اضغط «قاطعني» إذا تبي توقفني',
  ended: 'انتهت المكالمة',
  text_fallback: 'الصوت متوقف، الرد مكتوب في المحادثة',
};

/**
 * Live voice call over the existing assistant chat. It owns the mic, the
 * speech-to-text leg and the playback. The answer itself comes from
 * `onUtterance`, which is the same function the text composer uses, so the
 * voice path inherits every server check of the text path.
 */
export function VoiceCallPanel({
  onUtterance,
  onClose,
}: {
  onUtterance: (text: string) => Promise<VoiceTurnResult>;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(
    (current: VoiceCallState, event: VoiceCallEvent) => nextVoiceCallState(current, event),
    'idle' as VoiceCallState
  );
  const [error, setError] = useState('');
  const [heard, setHeard] = useState('');
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [draftPending, setDraftPending] = useState(false);

  const stateRef = useRef<VoiceCallState>('idle');
  stateRef.current = state;
  // One element for the whole call: iOS only lets an element that was started
  // inside a tap play later without another tap.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const unlockedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<{ token: string; maxSeconds: number } | null>(null);
  const turnRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  // The parent re-renders on every chat update. Callbacks live in refs so a
  // re-render can never re-run the cleanup below and cut the mic or the voice.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  const clearIdleTimer = () => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  };

  const stopPlayback = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);

  /** Releases the mic completely. Called on every path out of recording. */
  const releaseMic = useCallback(() => {
    if (recordTimerRef.current) window.clearTimeout(recordTimerRef.current);
    recordTimerRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const endCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    turnRef.current += 1;
    clearIdleTimer();
    releaseMic();
    stopPlayback();
    dispatch('end_call');
    onCloseRef.current();
  }, [releaseMic, stopPlayback]);

  // Hard ceiling on a call, plus cleanup when the panel unmounts for any reason.
  useEffect(() => {
    const ceiling = window.setTimeout(endCall, VOICE_LIMITS.maxCallMs);
    return () => {
      window.clearTimeout(ceiling);
      clearIdleTimer();
      turnRef.current += 1;
      releaseMic();
      stopPlayback();
    };
  }, [endCall, releaseMic, stopPlayback]);

  const armIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(endCall, VOICE_LIMITS.idleTimeoutMs);
  }, [endCall]);

  useEffect(() => {
    if (state === 'idle' || state === 'text_fallback') armIdleTimer();
    else clearIdleTimer();
  }, [state, armIdleTimer]);

  /** Plays a silent clip inside the tap so Safari/iOS allows the reply later. */
  function unlockAudio() {
    if (unlockedRef.current) return;
    try {
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      const silent = new Blob([silentWav()], { type: 'audio/wav' });
      const url = URL.createObjectURL(silent);
      audio.src = url;
      void audio
        .play()
        .catch(() => undefined)
        .finally(() => URL.revokeObjectURL(url));
      unlockedRef.current = true;
    } catch {
      /* playback may still work; failure shows as text later */
    }
  }

  async function ensureSession(): Promise<string | null> {
    if (sessionRef.current) return sessionRef.current.token;
    const response = await fetch('/api/voice/session', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.session_token) {
      setError(voiceErrorMessage(data?.error, response.status));
      dispatch('fail');
      return null;
    }
    sessionRef.current = {
      token: data.session_token,
      maxSeconds: Math.min(Number(data.caps?.max_audio_seconds) || 30, 60),
    };
    return data.session_token;
  }

  const failWith = useCallback((code: string | undefined, status: number | null, turn: number) => {
    if (turn !== turnRef.current) return;
    if (code === 'session_expired' || code === 'unauthorized') sessionRef.current = null;
    setError(voiceErrorMessage(code, status));
    // Limits and a missing feature end the voice leg; everything else lets the person retry.
    const retryable = ['no_speech', 'too_many_requests', 'session_expired', 'audio_too_large'];
    dispatch(code && retryable.includes(code) ? 'stop_listening' : 'fail');
  }, []);

  const speak = useCallback(
    async (reply: string, ticket: string, turn: number) => {
      const spoken = prepareSpokenText(reply);
      if (!spoken) {
        dispatch('audio_finished');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch('reply_ready');
      try {
        const response = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken, ticket }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          failWith(data?.error, response.status, turn);
          return;
        }
        const blob = await response.blob();
        if (turn !== turnRef.current) return;
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.onended = () => {
          if (turn !== turnRef.current) return;
          stopPlayback();
          dispatch('audio_finished');
        };
        audio.onerror = () => {
          if (turn !== turnRef.current) return;
          stopPlayback();
          failWith(undefined, 500, turn);
        };
        await audio.play();
        if (turn === turnRef.current) dispatch('audio_started');
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || turn !== turnRef.current) return;
        stopPlayback();
        // `play()` is rejected when the browser blocks audio, a dropped
        // connection rejects `fetch`; both end in text, never in a stuck panel.
        failWith(undefined, (err as Error)?.name === 'NotAllowedError' ? 500 : null, turn);
      }
    },
    [failWith, stopPlayback]
  );

  const handleRecording = useCallback(
    async (blob: Blob, mime: string, turn: number) => {
      if (blob.size < MIN_RECORDING_BYTES) {
        failWith('no_speech', 422, turn);
        return;
      }
      dispatch('speech_final');
      const controller = new AbortController();
      abortRef.current = controller;
      let transcript = '';
      let ticket = '';
      try {
        const response = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': mime.split(';')[0] || 'audio/webm', 'x-voice-session': sessionRef.current?.token ?? '' },
          body: blob,
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.text || !data.ticket) {
          failWith(data?.error, response.status, turn);
          return;
        }
        transcript = String(data.text);
        ticket = String(data.ticket);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        failWith(undefined, null, turn);
        return;
      }
      if (turn !== turnRef.current) return;
      setHeard(transcript);
      // A spoken "yes" is only ever a message to the assistant. It never
      // reaches the approval path, and the person is told where the real
      // confirm button lives.
      if (looksLikeVoiceApproval(transcript)) setApprovalNotice(true);
      const result = await onUtteranceRef.current(transcript);
      if (turn !== turnRef.current) return;
      if (!result) {
        setError('تعذر الحصول على رد. الخطأ ظاهر في المحادثة.');
        dispatch('fail');
        return;
      }
      setDraftPending(result.hasDraft);
      if (result.hasDraft) setApprovalNotice(true);
      await speak(result.reply, ticket, turn);
    },
    [failWith, speak]
  );

  // The mic opens ONLY from this function, and it is only called by a tap.
  async function startListening() {
    if (state === 'speaking') {
      // Barge-in: cut the voice first, then listen.
      turnRef.current += 1;
      stopPlayback();
      dispatch('barge_in');
    }
    if (state === 'thinking' || state === 'listening') return;

    setError('');
    setApprovalNotice(false);
    unlockAudio();
    const turn = ++turnRef.current;

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('متصفحك ما يدعم تسجيل الصوت. حدّثه أو كمّل كتابة.');
      dispatch('fail');
      return;
    }
    const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      setError(voiceErrorMessage('unsupported_audio', 415));
      dispatch('fail');
      return;
    }

    try {
      const token = await ensureSession();
      if (!token || turn !== turnRef.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (turn !== turnRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        releaseMic();
        failWith(undefined, 500, turn);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mime;
        releaseMic();
        if (turn !== turnRef.current) return;
        void handleRecording(new Blob(chunks, { type }), type, turn);
      };
      recorder.start();
      dispatch('start_listening');
      recordTimerRef.current = window.setTimeout(
        () => stopListening(),
        (sessionRef.current?.maxSeconds ?? 30) * 1000
      );
    } catch (voiceError) {
      releaseMic();
      if (turn !== turnRef.current) return;
      setError(microphoneAccessErrorMessage(voiceError));
      dispatch('fail');
    }
  }

  function stopListening() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    if (recordTimerRef.current) window.clearTimeout(recordTimerRef.current);
    recordTimerRef.current = null;
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  }

  const busy = state === 'thinking';
  const listening = state === 'listening';
  const speaking = state === 'speaking';

  return (
    <div
      className="border-t border-border bg-card p-4"
      role="region"
      aria-label="مكالمة صوتية مع المساعد"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">مكالمة صوتية</div>
          <div className="text-[12px] text-muted-foreground" aria-live="polite">
            {STATE_LABEL[state]}
          </div>
        </div>
        <button
          type="button"
          onClick={endCall}
          className={buttonClasses({ variant: 'outline', size: 'sm' })}
          aria-label="إنهاء المكالمة"
        >
          <PhoneOff className="h-3.5 w-3.5" />
          إنهاء
        </button>
      </div>

      {heard && state !== 'idle' && (
        <p className="mt-3 rounded-lg border border-border bg-background-elevated px-3 py-2 text-[12.5px] leading-6 text-foreground-subtle">
          سمعتك: {heard}
        </p>
      )}

      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {approvalNotice && (
        <div className="mt-3">
          <Alert tone="warning">
            {draftPending ? 'جهزت مسودة وما نُفذ شي. ' : ''}
            {VOICE_APPROVAL_NOTICE}{' '}
            <Link href="/optimizer" className="font-semibold underline">
              مركز الموافقات
            </Link>
          </Alert>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        {speaking ? (
          <button
            type="button"
            onClick={startListening}
            className={buttonClasses({ variant: 'primary', size: 'md' })}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            قاطعني وأتكلم
          </button>
        ) : listening ? (
          <button
            type="button"
            onClick={stopListening}
            className={buttonClasses({ variant: 'primary', size: 'md' })}
            aria-label="خلصت كلامي"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            خلصت كلامي
          </button>
        ) : (
          <button
            type="button"
            onClick={startListening}
            disabled={busy}
            className={cn(buttonClasses({ variant: 'primary', size: 'md' }), 'disabled:opacity-60')}
            aria-label="ابدأ التحدث"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
            {busy ? 'لحظة...' : 'تكلم'}
          </button>
        )}
        <button
          type="button"
          onClick={endCall}
          className={buttonClasses({ variant: 'ghost', size: 'md' })}
        >
          <Keyboard className="h-4 w-4" />
          كمّل كتابة
        </button>
      </div>
      <p className="mt-3 text-[11.5px] leading-5 text-muted-foreground">
        الميكروفون يشتغل بس لما تضغط. تسجيلك يروح من جهازك لسيرفرنا ومنه لمزود الصوت (ElevenLabs) عشان يتحول لنص، والرد كذلك يتحول لصوت عنده. ما نحفظ الصوت عندنا، أما مدة حفظه عند المزود فتتبع شروطه. الرد الكامل يبقى مكتوب في المحادثة.
      </p>
    </div>
  );
}

/** 0.1s of silence as a WAV, built in the browser so no data: URL is needed (CSP allows blob:). */
function silentWav(): ArrayBuffer {
  const rate = 8000;
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buffer);
  const str = (o: number, t: string) => [...t].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  return buffer;
}
