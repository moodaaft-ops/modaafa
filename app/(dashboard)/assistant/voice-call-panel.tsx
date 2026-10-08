'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { Keyboard, LoaderCircle, Mic, PhoneOff, Square } from 'lucide-react';
import {
  appendVoiceTranscript,
  microphoneAccessErrorMessage,
  requestMicrophoneAccess,
  speechRecognitionErrorMessage,
} from '@/lib/ai/voice-input';
import {
  looksLikeVoiceApproval,
  nextVoiceCallState,
  prepareSpokenText,
  ttsFailureMessage,
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
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
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
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
    }
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);

  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      /* already stopped */
    }
  }, []);

  const endCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    turnRef.current += 1;
    clearIdleTimer();
    stopRecognition();
    stopPlayback();
    dispatch('end_call');
    onCloseRef.current();
  }, [stopPlayback, stopRecognition]);

  // Hard ceiling on a call, plus cleanup when the panel unmounts for any reason.
  useEffect(() => {
    const ceiling = window.setTimeout(endCall, VOICE_LIMITS.maxCallMs);
    return () => {
      window.clearTimeout(ceiling);
      clearIdleTimer();
      turnRef.current += 1;
      stopRecognition();
      stopPlayback();
    };
  }, [endCall, stopPlayback, stopRecognition]);

  const armIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(endCall, VOICE_LIMITS.idleTimeoutMs);
  }, [endCall]);

  useEffect(() => {
    if (state === 'idle' || state === 'text_fallback') armIdleTimer();
    else clearIdleTimer();
  }, [state, armIdleTimer]);

  const speak = useCallback(
    async (reply: string, turn: number) => {
      const spoken = prepareSpokenText(reply);
      if (!spoken) {
        dispatch('audio_finished');
        return;
      }
      const controller = new AbortController();
      ttsAbortRef.current = controller;
      dispatch('reply_ready');
      try {
        const response = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken }),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (turn === turnRef.current) {
            setError(ttsFailureMessage(response.status));
            dispatch('fail');
          }
          return;
        }
        const blob = await response.blob();
        if (turn !== turnRef.current) return;
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          if (turn !== turnRef.current) return;
          stopPlayback();
          dispatch('audio_finished');
        };
        audio.onerror = () => {
          if (turn !== turnRef.current) return;
          stopPlayback();
          setError(ttsFailureMessage(500));
          dispatch('fail');
        };
        await audio.play();
        if (turn === turnRef.current) dispatch('audio_started');
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || turn !== turnRef.current) return;
        stopPlayback();
        // `play()` is rejected when the browser blocks audio, a dropped
        // connection rejects `fetch`; both end in text, never in a stuck panel.
        setError(
          (err as Error)?.name === 'NotAllowedError' ? ttsFailureMessage(500) : ttsFailureMessage(null)
        );
        dispatch('fail');
      }
    },
    [stopPlayback]
  );

  const handleTranscript = useCallback(
    async (transcript: string, turn: number) => {
      setHeard(transcript);
      dispatch('speech_final');
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
      await speak(result.reply, turn);
    },
    [speak]
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
    const turn = ++turnRef.current;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('متصفحك ما يدعم التعرف على الصوت. جرّب Chrome أو Safari، أو كمّل كتابة.');
      dispatch('fail');
      return;
    }

    try {
      const permission = await navigator.permissions
        ?.query({ name: 'microphone' as PermissionName })
        .catch(() => null);
      if (permission?.state === 'denied') {
        throw Object.assign(new Error('Microphone permission denied'), { name: 'NotAllowedError' });
      }
      if (navigator.mediaDevices?.getUserMedia) {
        await requestMicrophoneAccess(() => navigator.mediaDevices.getUserMedia({ audio: true }));
      }
      if (turn !== turnRef.current) return;

      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.lang = 'ar-SA';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      let finalText = '';
      let sawError = false;
      recognition.onstart = () => dispatch('start_listening');
      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results as ArrayLike<any>)
          .map((result: any) => result[0]?.transcript ?? '')
          .join(' ');
        finalText = appendVoiceTranscript('', transcript);
        setHeard(finalText);
      };
      recognition.onerror = (event: any) => {
        sawError = true;
        const message = speechRecognitionErrorMessage(event?.error);
        if (message) setError(message);
        // A hard failure moves to text. A quiet "no speech" just goes back to idle.
        if (event?.error === 'no-speech' || event?.error === 'aborted') dispatch('stop_listening');
        else dispatch('fail');
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        if (turn !== turnRef.current || sawError) return;
        if (!finalText.trim()) {
          setError('لم أسمع كلاماً واضحاً. اضغط الميكروفون وأعد المحاولة.');
          dispatch('stop_listening');
          return;
        }
        void handleTranscript(finalText.trim(), turn);
      };
      recognition.start();
    } catch (voiceError) {
      if (turn !== turnRef.current) return;
      setError(microphoneAccessErrorMessage(voiceError));
      dispatch('fail');
    }
  }

  function stopListening() {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    // `stop` (not `abort`) lets the engine deliver what it already heard.
    try {
      recognition.stop();
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
        الميكروفون يشتغل بس لما تضغط. ما نسجّل صوتك، والرد الكامل يبقى مكتوب في المحادثة.
      </p>
    </div>
  );
}
