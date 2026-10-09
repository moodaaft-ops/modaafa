'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { Keyboard, LoaderCircle, Mic, MicOff, PhoneOff, Square } from 'lucide-react';
import { microphoneAccessErrorMessage } from '@/lib/ai/voice-input';
import {
  looksLikeVoiceApproval,
  MIN_RECORDING_BYTES,
  nextVoiceCallState,
  voiceErrorMessage,
  VOICE_APPROVAL_NOTICE,
  VOICE_LIMITS,
  type VoiceCallEvent,
  type VoiceCallState,
} from '@/lib/ai/voice-session';
import { runCallStart } from '@/lib/ai/voice-call-start';
import { PcmCapture } from '@/lib/ai/voice-pcm';
import { BARGE_VAD, createVad, LISTEN_VAD } from '@/lib/ai/voice-vad';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

/** What the chat route returned for a spoken question. `speech` is absent when it granted none. */
export type VoiceTurnResult = {
  reply: string;
  hasDraft: boolean;
  speech?: { spokenText: string; speakTicket: string } | null;
  /** The server ended the call for a reason the person must see (for example the account changed). */
  fatal?: 'account_changed' | 'session_expired' | 'session_ended';
} | null;

const TICK_MS = 50;
/** Silence this long (no speech yet) restarts the recorder so a quiet room never builds a big file. */
const RECORDER_RECYCLE_MS = 6000;

/**
 * Hands-free voice call over the existing assistant chat.
 *
 * One tap on «ابدأ المكالمة» opens the microphone for the length of the call.
 * The turn ends by itself when the person stops talking, the assistant answers
 * aloud, and talking over the assistant cuts it off. The mic is never opened
 * without that tap, it is visibly open the whole time, and «إنهاء» (or the
 * idle limit) closes it. The answer comes from `onUtterance`, the same code
 * path the text composer uses, so every server check of the text path applies.
 */
export function VoiceCallPanel({
  customerId,
  onUtterance,
  onClose,
}: {
  /** The ad account this call is scoped to. If it changes, the call ends. */
  customerId: string | null;
  onUtterance: (text: string, voiceTicket: string) => Promise<VoiceTurnResult>;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(
    (current: VoiceCallState, event: VoiceCallEvent) => nextVoiceCallState(current, event),
    'idle' as VoiceCallState
  );
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [heard, setHeard] = useState('');
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [draftPending, setDraftPending] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [provider, setProvider] = useState<'elevenlabs' | 'mock' | null>(null);

  const stateRef = useRef<VoiceCallState>('idle');
  stateRef.current = state;
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const tickRef = useRef<number | null>(null);
  const recorderRef = useRef<PcmCapture | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recorderStartRef = useRef(0);
  const listenVadRef = useRef(createVad(LISTEN_VAD));
  const bargeVadRef = useRef(createVad(BARGE_VAD));
  const sessionRef = useRef<{ token: string; maxSeconds: number } | null>(null);
  const serverEndedRef = useRef<string | null>(null);
  /** Bumped whenever a call ends or the panel unmounts; an attempt that started earlier is then stale. */
  const genRef = useRef(0);
  const turnRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const lastFloorRef = useRef(0);
  // The parent re-renders on every chat update. Callbacks live in refs so a
  // re-render can never re-run the cleanup below and cut the mic or the voice.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const customerRef = useRef(customerId);

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

  const discardRecorder = useCallback(() => {
    recorderRef.current = null;
  }, []);

  /** Closes the microphone and the audio graph completely. */
  const releaseMic = useCallback(() => {
    if (tickRef.current) window.clearInterval(tickRef.current);
    tickRef.current = null;
    discardRecorder();
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    setUserSpeaking(false);
  }, [discardRecorder]);

  /**
   * Tells the server the call is over so the session token and every ticket
   * under it stop working there too, not only in this tab. Best effort: if it
   * cannot be sent (offline, tab closing) the short token lifetime still ends it.
   */
  const sendEndToken = useCallback((token: string) => {
    if (serverEndedRef.current === token) return;
    serverEndedRef.current = token;
    void fetch('/api/voice/end', { method: 'POST', headers: { 'x-voice-session': token }, keepalive: true }).catch(() => undefined);
  }, []);

  const endOnServer = useCallback(() => {
    const token = sessionRef.current?.token;
    if (token) sendEndToken(token);
  }, [sendEndToken]);

  const endCall = useCallback(() => {
    // Invalidate any start that is still waiting on the session or the mic prompt.
    genRef.current += 1;
    if (endedRef.current) return;
    endedRef.current = true;
    turnRef.current += 1;
    abortRef.current?.abort();
    endOnServer();
    clearIdleTimer();
    releaseMic();
    stopPlayback();
    dispatch('end_call');
    onCloseRef.current();
  }, [endOnServer, releaseMic, stopPlayback]);

  // Hard ceiling on a call, plus cleanup when the panel unmounts for any reason.
  useEffect(() => {
    const ceiling = window.setTimeout(endCall, VOICE_LIMITS.maxCallMs);
    return () => {
      window.clearTimeout(ceiling);
      clearIdleTimer();
      genRef.current += 1;
      turnRef.current += 1;
      abortRef.current?.abort();
      endOnServer();
      releaseMic();
      stopPlayback();
    };
  }, [endCall, endOnServer, releaseMic, stopPlayback]);

  // Closing or leaving the tab also ends the call on the server.
  useEffect(() => {
    window.addEventListener('pagehide', endOnServer);
    return () => window.removeEventListener('pagehide', endOnServer);
  }, [endOnServer]);

  // Switching ad account mid-call ends it: the open session, any ticket in
  // flight and the mic all belong to the old account.
  useEffect(() => {
    if (customerRef.current !== customerId) endCall();
  }, [customerId, endCall]);

  // A call where nobody has said anything for a while ends itself. Any real
  // activity (listening heard speech, thinking, speaking) clears the timer.
  const armIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(endCall, VOICE_LIMITS.idleTimeoutMs);
  }, [endCall]);

  useEffect(() => {
    if (!started) return;
    if ((state === 'listening' && !userSpeaking) || state === 'idle' || state === 'text_fallback') armIdleTimer();
    else clearIdleTimer();
  }, [state, userSpeaking, started, armIdleTimer]);

  /** Starts a fresh capture of the mic samples for the next turn (16-bit mono WAV when it is sent). */
  function startRecorder() {
    const ctx = ctxRef.current;
    if (!ctx || !streamRef.current) return;
    recorderRef.current = new PcmCapture(ctx.sampleRate, sessionRef.current?.maxSeconds ?? 30);
    recorderStartRef.current = performance.now();
  }

  /** Back to waiting for the person, hands-free. */
  const beginListening = useCallback(() => {
    if (endedRef.current || !streamRef.current) return;
    setUserSpeaking(false);
    listenVadRef.current.reset();
    dispatch('start_listening');
    startRecorder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failWith = useCallback(
    (code: string | undefined, status: number | null, turn: number) => {
      if (turn !== turnRef.current) return;
      // Close the server side first: clearing the token before this would lose the end request.
      if (code === 'session_ended' || code === 'account_changed') endOnServer();
      if (code === 'session_expired' || code === 'unauthorized' || code === 'session_ended' || code === 'account_changed') sessionRef.current = null;
      setError(voiceErrorMessage(code, status));
      const retryable = ['no_speech', 'too_many_requests', 'session_expired', 'audio_too_large'];
      if (code && retryable.includes(code) && streamRef.current) {
        // Say what went wrong, then keep listening: the call is still live.
        dispatch('stop_listening');
        window.setTimeout(() => {
          if (turn === turnRef.current && !endedRef.current) beginListening();
        }, 600);
        return;
      }
      // Hard failure: the voice leg stops and the microphone is released, the
      // written answer stays in the chat.
      releaseMic();
      setStarted(false);
      dispatch('fail');
    },
    [beginListening, endOnServer, releaseMic]
  );

  const playReply = useCallback(
    async (speech: { spokenText: string; speakTicket: string }, turn: number) => {
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch('reply_ready');
      try {
        const response = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(customerRef.current ? { 'x-voice-customer': customerRef.current } : {}),
          },
          body: JSON.stringify({ text: speech.spokenText, ticket: speech.speakTicket }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          // The answer is already written in the chat. A failed voice leg does not end the call.
          if (turn !== turnRef.current) return;
          if (data?.error === 'session_ended' || data?.error === 'account_changed') {
            // The server closed this call: do not keep a live mic on a dead session.
            failWith(data.error, response.status, turn);
            return;
          }
          setError(voiceErrorMessage(data?.error, response.status));
          dispatch('audio_finished');
          beginListening();
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
          beginListening();
        };
        audio.onerror = () => {
          if (turn !== turnRef.current) return;
          stopPlayback();
          setError(voiceErrorMessage(undefined, 500));
          dispatch('audio_finished');
          beginListening();
        };
        bargeVadRef.current.reset();
        await audio.play();
        if (turn === turnRef.current) dispatch('audio_started');
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || turn !== turnRef.current) return;
        stopPlayback();
        setError(voiceErrorMessage(undefined, (err as Error)?.name === 'NotAllowedError' ? 500 : null));
        dispatch('audio_finished');
        beginListening();
      }
    },
    [beginListening, failWith, stopPlayback]
  );

  const handleRecording = useCallback(
    async (blob: Blob, turn: number) => {
      if (blob.size < MIN_RECORDING_BYTES) {
        failWith('no_speech', 422, turn);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      let transcript = '';
      let ticket = '';
      try {
        const response = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/wav',
            'x-voice-session': sessionRef.current?.token ?? '',
            ...(customerRef.current ? { 'x-voice-customer': customerRef.current } : {}),
          },
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
      const result = await onUtteranceRef.current(transcript, ticket);
      if (turn !== turnRef.current) return;
      if (!result) {
        setError('تعذر الحصول على رد. الخطأ ظاهر في المحادثة.');
        dispatch('stop_listening');
        window.setTimeout(() => {
          if (turn === turnRef.current && !endedRef.current) beginListening();
        }, 600);
        return;
      }
      if (result.fatal) {
        // The server refused the ticket for this account or session. Nothing was spoken.
        endOnServer();
        sessionRef.current = null;
        setError(voiceErrorMessage(result.fatal, 409));
        releaseMic();
        setStarted(false);
        dispatch('fail');
        return;
      }
      setDraftPending(result.hasDraft);
      if (result.hasDraft) setApprovalNotice(true);
      if (!result.speech) {
        // No speech granted (flag off for this reply, or empty reply): text only, keep listening.
        dispatch('stop_listening');
        beginListening();
        return;
      }
      await playReply(result.speech, turn);
    },
    [beginListening, endOnServer, failWith, playReply, releaseMic]
  );

  /** The person stopped talking: close this recording and send it. */
  function finishTurn() {
    const capture = recorderRef.current;
    if (!capture) return;
    const turn = ++turnRef.current;
    setUserSpeaking(false);
    dispatch('speech_final');
    recorderRef.current = null;
    try {
      void handleRecording(new Blob([capture.toWav()], { type: 'audio/wav' }), turn);
    } catch {
      failWith(undefined, 500, turn);
    }
  }

  /** Talking over the assistant: cut the voice and take the floor. */
  function bargeIn() {
    turnRef.current += 1;
    lastFloorRef.current = bargeVadRef.current.noiseFloor;
    stopPlayback();
    dispatch('barge_in');
    dispatch('start_listening');
    const vad = listenVadRef.current;
    vad.reset();
    vad.seed(Math.min(lastFloorRef.current, 0.01));
    vad.forceSpeech(performance.now());
    setUserSpeaking(true);
    startRecorder();
  }

  function onTick() {
    const analyser = analyserRef.current;
    if (!analyser || endedRef.current) return;
    if (mutedRef.current) return;
    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    const now = performance.now();
    const current = stateRef.current;

    if (current === 'listening') {
      const event = listenVadRef.current.push(rms, now);
      if (event === 'speech_start') setUserSpeaking(true);
      else if (event === 'speech_end' || event === 'too_long') finishTurn();
      else if (event === 'speech_cancel') {
        setUserSpeaking(false);
        startRecorder();
      } else if (!listenVadRef.current.speaking && now - recorderStartRef.current > RECORDER_RECYCLE_MS) {
        startRecorder();
      }
    } else if (current === 'speaking') {
      if (bargeVadRef.current.push(rms, now) === 'speech_start') bargeIn();
    }
  }

  /** Plays a short silence inside the tap so Safari/iOS allows the reply later. */
  function unlockAudio() {
    try {
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.setAttribute('playsinline', 'true');
      const url = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
      audio.src = url;
      void audio
        .play()
        .catch(() => undefined)
        .finally(() => URL.revokeObjectURL(url));
    } catch {
      /* playback may still work; a failure shows as text later */
    }
  }

  /** The only place the microphone opens. Called by a tap on «ابدأ المكالمة». */
  async function startCall() {
    if (starting || started) return;
    setError('');
    setApprovalNotice(false);
    setStarting(true);
    unlockAudio();
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioCtx || !AudioCtx.prototype?.createScriptProcessor) {
      setError('متصفحك ما يدعم المكالمة الصوتية. حدّثه أو كمّل كتابة.');
      dispatch('fail');
      setStarting(false);
      return;
    }
    const gen = ++genRef.current;
    let opened: { token: string; maxSeconds: number; provider: 'mock' | 'elevenlabs' } | null = null;
    let sessionFailure: { code?: string; status: number } | null = null;
    const result = await runCallStart<AudioContext, MediaStream>({
      isCurrent: () => gen === genRef.current,
      // Created inside the tap: iOS keeps the context suspended otherwise.
      createContext: () => {
        const created: AudioContext = new AudioCtx();
        ctxRef.current = created;
        return created;
      },
      closeContext: (created) => {
        if (ctxRef.current === created) ctxRef.current = null;
        if (created.state !== 'closed') void created.close().catch(() => undefined);
      },
      openSession: async () => {
        if (sessionRef.current) return { ok: true, token: sessionRef.current.token };
        const response = await fetch('/api/voice/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: customerRef.current }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.session_token) {
          sessionFailure = { code: data?.error, status: response.status };
          return { ok: false };
        }
        opened = {
          token: data.session_token,
          maxSeconds: Math.min(Number(data.caps?.max_audio_seconds) || 30, 60),
          provider: data.provider === 'mock' ? 'mock' : 'elevenlabs',
        };
        return { ok: true, token: data.session_token };
      },
      endSessionOnServer: (token) => {
        sendEndToken(token);
        // Forget the token that was just closed, so a retry cannot reuse an ended session.
        if (sessionRef.current?.token === token) sessionRef.current = null;
      },
      acquireMic: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
      stopStream: (stream) => stream.getTracks().forEach((track) => track.stop()),
      resumeContext: (created) => created.resume(),
      commit: ({ ctx, stream, token }) => {
        if (opened) {
          sessionRef.current = { token: opened.token, maxSeconds: opened.maxSeconds };
          setProvider(opened.provider);
        } else if (!sessionRef.current) {
          sessionRef.current = { token, maxSeconds: 30 };
        }
        streamRef.current = stream;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        analyserRef.current = analyser;
        // Raw samples for the 16-bit PCM WAV that is uploaded. The node's own output is
        // never written, so connecting it to the destination plays silence.
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => recorderRef.current?.push(event.inputBuffer.getChannelData(0));
        source.connect(processor);
        processor.connect(ctx.destination);
        processorRef.current = processor;
        endedRef.current = false;
        setStarted(true);
        beginListening();
        tickRef.current = window.setInterval(onTick, TICK_MS);
      },
    });
    if (result.status === 'session_failed') {
      const failure = sessionFailure as { code?: string; status: number } | null;
      setError(voiceErrorMessage(failure?.code, failure?.status ?? null));
      dispatch('fail');
    } else if (result.status === 'failed') {
      setError(microphoneAccessErrorMessage(result.error));
      dispatch('fail');
    }
    // 'cancelled': the call was ended while it was opening. Everything this attempt
    // acquired has already been released and nothing is shown.
    setStarting(false);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    if (next) {
      setUserSpeaking(false);
      if (stateRef.current === 'listening') startRecorder();
    } else {
      listenVadRef.current.reset();
      bargeVadRef.current.reset();
    }
  }

  /** Back from the text fallback: a fresh tap reopens the voice leg. */
  function retryVoice() {
    void startCall();
  }

  const thinking = state === 'thinking';
  const speaking = state === 'speaking';
  const listening = state === 'listening';
  const live = started && streamRef.current !== null && !muted;

  const label = !started
    ? state === 'text_fallback'
      ? 'الصوت متوقف، الرد مكتوب في المحادثة'
      : 'اضغط «ابدأ المكالمة» وتكلم بشكل طبيعي'
    : muted
      ? 'الميكروفون مكتوم'
      : thinking
        ? 'أحلل سؤالك...'
        : speaking
          ? 'أتكلم الحين. تكلم فوقي وأوقف'
          : userSpeaking
            ? 'أسمعك...'
            : listening
              ? 'تكلم، أنا أسمعك'
              : 'لحظة...';

  return (
    <div className="border-t border-border bg-card p-4" role="region" aria-label="مكالمة صوتية مع المساعد">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            مكالمة صوتية
            {live && (
              <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />
                الميكروفون مفتوح
              </span>
            )}
          </div>
          <div className="text-[12px] text-muted-foreground" aria-live="polite">
            {label}
          </div>
        </div>
        <button
          type="button"
          onClick={endCall}
          className={buttonClasses({ variant: 'danger', size: 'md' })}
          aria-label="إنهاء المكالمة"
        >
          <PhoneOff className="h-4 w-4" />
          إنهاء المكالمة
        </button>
      </div>

      {provider === 'mock' && (
        <div className="mt-3">
          <Alert tone="warning">
            وضع تجريبي: هذا محاكي مو صوت حقيقي. أي كلام تقوله يُفهم كسؤال ثابت، والرد نغمتان قصيرتان. الغرض تجربة سلاسة المكالمة فقط.
          </Alert>
        </div>
      )}

      {heard && started && (
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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!started ? (
          <button
            type="button"
            onClick={state === 'text_fallback' ? retryVoice : startCall}
            disabled={starting}
            className={cn(buttonClasses({ variant: 'primary', size: 'lg' }), 'disabled:opacity-60')}
          >
            {starting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
            {starting ? 'لحظة...' : state === 'text_fallback' ? 'جرّب الصوت مرة ثانية' : 'ابدأ المكالمة'}
          </button>
        ) : (
          <>
            {speaking && (
              <button type="button" onClick={bargeIn} className={buttonClasses({ variant: 'primary', size: 'md' })}>
                <Square className="h-3.5 w-3.5 fill-current" />
                قاطعني
              </button>
            )}
            {listening && userSpeaking && (
              <button type="button" onClick={finishTurn} className={buttonClasses({ variant: 'subtle', size: 'md' })}>
                <Square className="h-3.5 w-3.5 fill-current" />
                خلصت كلامي
              </button>
            )}
            {thinking && (
              <span className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> لحظة...
              </span>
            )}
            <button
              type="button"
              onClick={toggleMute}
              className={buttonClasses({ variant: 'outline', size: 'md' })}
              aria-pressed={muted}
            >
              {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {muted ? 'ألغِ الكتم' : 'اكتم'}
            </button>
          </>
        )}
        <button type="button" onClick={endCall} className={buttonClasses({ variant: 'ghost', size: 'md' })}>
          <Keyboard className="h-4 w-4" />
          كمّل كتابة
        </button>
      </div>
      <p className="mt-3 text-[11.5px] leading-5 text-muted-foreground">
        الميكروفون يفتح بضغطة «ابدأ المكالمة» ويبقى مفتوح طول المكالمة لين تضغط إنهاء أو تسكت دقيقة ونص. تسجيلك يروح من جهازك لسيرفرنا ومنه لمزود الصوت (ElevenLabs) عشان يتحول لنص، والرد كذلك يتحول لصوت عنده. ما نحفظ الصوت عندنا، أما مدة حفظه عند المزود فتتبع شروطه. الرد الكامل يبقى مكتوب في المحادثة.
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
