'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import { LoaderCircle, Mic, MicOff, RotateCcw, X } from 'lucide-react';
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
import { ASSISTANT } from '@/lib/assistant/persona';
import { cn } from '@/lib/utils';

/** What the chat route returned for a spoken question. `speech` is absent when it granted none. */
export type VoiceTurnResult = {
  reply: string;
  hasDraft: boolean;
  speech?: { spokenText: string; speakTicket: string } | null;
  /** The server ended the call for a reason the person must see (for example the account changed). */
  fatal?: 'account_changed' | 'session_expired' | 'session_ended';
} | null;

/** Lets the composer's voice button open the mic inside its own tap (iOS needs the gesture). */
export type VoiceCallHandle = { start: () => void };

const TICK_MS = 50;
/** Silence this long (no speech yet) restarts the recorder so a quiet room never builds a big file. */
const RECORDER_RECYCLE_MS = 6000;

/**
 * Hands-free voice call over the existing assistant chat, drawn the way
 * ChatGPT does it inside a conversation: the composer turns into one rounded
 * voice bar (mute, a live level, «إنهاء») and every turn still lands in the
 * thread as text, so cards and approval buttons stay where they are.
 *
 * One tap on the composer's voice button (it calls `start` through the ref
 * inside that tap) opens the microphone for the length of the call.
 * The turn ends by itself when the person stops talking, the assistant answers
 * aloud, and talking over the assistant cuts it off. The mic is never opened
 * without that tap, it is visibly open the whole time, and «إنهاء» (or the
 * idle limit) closes it. The answer comes from `onUtterance`, the same code
 * path the text composer uses, so every server check of the text path applies.
 */
export const VoiceCallPanel = forwardRef<
  VoiceCallHandle,
  {
    /** The ad account this call is scoped to. If it changes, the call ends. */
    customerId: string | null;
    onUtterance: (text: string, voiceTicket: string) => Promise<VoiceTurnResult>;
    onClose: () => void;
  }
>(function VoiceCallPanel({ customerId, onUtterance, onClose }, ref) {
  const [state, dispatch] = useReducer(
    (current: VoiceCallState, event: VoiceCallEvent) => nextVoiceCallState(current, event),
    'idle' as VoiceCallState
  );
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
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
  /** The level bars read the mic through a CSS variable, so the 50ms tick never re-renders. */
  const waveRef = useRef<HTMLSpanElement | null>(null);

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
      // A spoken "yes" is only ever a message to the assistant. It never
      // reaches the approval path, and the person is told where the real
      // confirm button lives.
      if (looksLikeVoiceApproval(transcript)) setApprovalNotice(true);
      // A short pre-recorded "one moment" while the answer is prepared. The
      // clips are static files; a missing file is simply silent.
      const filler = startFiller();
      const result = await onUtteranceRef.current(transcript, ticket).finally(() => filler.stop());
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
    waveRef.current?.style.setProperty('--level', Math.min(1, rms * 14).toFixed(3));
    const now = performance.now();
    const current = stateRef.current;

    if (current === 'listening') {
      const event = listenVadRef.current.push(rms, now);
      if (event === 'speech_start') {
        setUserSpeaking(true);
        setError('');
      }
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

  // The composer's voice button calls this inside its own tap.
  const startRef = useRef(startCall);
  startRef.current = startCall;
  useImperativeHandle(ref, () => ({ start: () => void startRef.current() }), []);

  const thinking = state === 'thinking';
  const speaking = state === 'speaking';
  const listening = state === 'listening';
  const failed = !started && !starting && (state === 'text_fallback' || Boolean(error));

  const label = starting
    ? 'لحظة…'
    : !started
      ? failed
        ? 'الصوت وقف. الرد مكتوب فوق'
        : 'اضغط وتكلم'
      : muted
        ? 'الميكروفون مكتوم'
        : thinking
          ? `${ASSISTANT.name} يفكر…`
          : speaking
            ? 'يتكلم. اضغط هنا عشان توقفه'
            : userSpeaking
              ? 'أسمعك…'
              : listening
                ? 'تكلم، أنا أسمعك'
                : 'لحظة…';

  // The middle of the bar doubles as the one action that fits the moment.
  const statusAction = speaking ? bargeIn : listening && userSpeaking ? finishTurn : null;
  const waveMode: WaveMode = !started || muted ? 'idle' : speaking ? 'speaking' : thinking ? 'thinking' : 'listening';

  return (
    <div role="region" aria-label={`مكالمة صوتية مع ${ASSISTANT.name}`} className="motion-safe:animate-fade-in-fast">
      {provider === 'mock' && (
        <p className="mb-2 rounded-[14px] bg-warning-soft px-3 py-2 text-[12.5px] leading-6 text-warning">
          وضع تجريبي: هذا محاكي مو صوت حقيقي. أي كلام تقوله يُفهم كسؤال ثابت، والرد نغمتان قصيرتان. الغرض تجربة سلاسة المكالمة فقط.
        </p>
      )}
      {error && <p className="mb-2 rounded-[14px] bg-danger-soft px-3 py-2 text-[12.5px] leading-6 text-danger">{error}</p>}
      {approvalNotice && (
        <p className="mb-2 rounded-[14px] bg-muted px-3 py-2 text-[12.5px] leading-6 text-foreground">
          {draftPending ? 'جهزت لك اقتراح وما نُفذ شي. ' : ''}
          {VOICE_APPROVAL_NOTICE}
        </p>
      )}

      <div className="flex items-center gap-2 rounded-[26px] border border-border bg-card p-2 shadow-[0_8px_28px_-14px_rgba(14,20,38,0.35)]">
        <button
          type="button"
          onClick={toggleMute}
          disabled={!started}
          aria-pressed={muted}
          aria-label={muted ? 'ألغِ الكتم' : 'اكتم الميكروفون'}
          className={cn(
            'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40',
            muted ? 'bg-danger-soft text-danger' : 'bg-muted text-foreground hover:bg-foreground/[0.1]'
          )}
        >
          {muted ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
        </button>

        {failed ? (
          <button
            type="button"
            onClick={retryVoice}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-start text-[14px] font-semibold text-foreground hover:bg-muted"
          >
            <RotateCcw className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">جرّب الصوت مرة ثانية</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={statusAction ?? (!started && !starting ? retryVoice : undefined)}
            disabled={!statusAction && (started || starting)}
            aria-live="polite"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-full px-3 text-start text-[14px] text-foreground enabled:hover:bg-muted disabled:cursor-default"
          >
            {starting ? (
              <LoaderCircle className="h-5 w-5 flex-shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <VoiceWave mode={waveMode} spanRef={waveRef} />
            )}
            <span className="truncate">{label}</span>
          </button>
        )}

        <button
          type="button"
          onClick={endCall}
          aria-label="إنهاء المكالمة"
          className="inline-flex h-11 flex-shrink-0 items-center gap-1.5 rounded-full bg-foreground px-4 text-[14px] font-semibold text-background transition-opacity hover:opacity-90"
        >
          <X className="h-4 w-4" />
          إنهاء
        </button>
      </div>
      <p className="mt-2 px-2 text-center text-[11.5px] leading-5 text-muted-foreground">
        الميكروفون مفتوح لين تضغط إنهاء. صوتك يتحول نص عند ElevenLabs وما نحفظه عندنا، والرد يبقى مكتوب في المحادثة.
      </p>
    </div>
  );
});

type WaveMode = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Five rounded bars. Listening follows the mic level (a CSS variable set by the
 * tick), speaking breathes on its own, thinking blinks the brand's lamp yellow.
 */
function VoiceWave({ mode, spanRef }: { mode: WaveMode; spanRef: React.RefObject<HTMLSpanElement> }) {
  const shape = [0.55, 0.85, 1, 0.85, 0.55];
  return (
    <span
      ref={spanRef}
      aria-hidden
      className="flex h-6 w-9 flex-shrink-0 items-center justify-center gap-[3px]"
      style={{ ['--level' as string]: '0' }}
    >
      {shape.map((weight, index) => (
        <span
          key={index}
          className={cn(
            'w-[4px] origin-center rounded-full transition-[height] duration-75',
            mode === 'thinking' ? 'bg-signal motion-safe:animate-lamp-blink' : 'bg-foreground',
            mode === 'speaking' && 'h-6 motion-safe:animate-voice-bar',
            mode === 'idle' && 'h-[5px] opacity-40'
          )}
          style={
            mode === 'listening'
              ? { height: `calc(5px + var(--level) * ${Math.round(19 * weight)}px)` }
              : mode === 'speaking'
                ? { animationDelay: `${index * 120}ms` }
                : mode === 'thinking'
                  ? { height: '5px', animationDelay: `${index * 140}ms` }
                  : undefined
          }
        />
      ))}
    </span>
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

/** Static «لحظة أشوف حسابك» clips in public/voice/, rotated per turn (spec 83, section 2). */
const FILLER_CLIPS = ['/voice/wait-1.mp3', '/voice/wait-2.mp3', '/voice/wait-3.mp3'];
let fillerIndex = 0;

function startFiller(): { stop: () => void } {
  if (typeof window === 'undefined' || typeof window.Audio === 'undefined') return { stop: () => undefined };
  const audio = new window.Audio(FILLER_CLIPS[fillerIndex++ % FILLER_CLIPS.length]);
  audio.volume = 0.9;
  void audio.play().catch(() => undefined);
  return {
    stop: () => {
      try {
        audio.pause();
      } catch {
        // already stopped
      }
    },
  };
}
