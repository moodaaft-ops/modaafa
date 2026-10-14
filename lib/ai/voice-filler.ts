/**
 * The short «لحظة أشوف» clip played while the answer is prepared, so the line
 * never goes silent for the 3 to 8 seconds the model and the voice provider
 * need. The clips are static files in public/voice/ (Fahad's voice, recorded
 * once, so they cost nothing per call).
 *
 * Three rules keep it from getting in the way:
 *  - it starts only after a short delay, so a fast reply plays no filler at all;
 *  - it is never cut mid-word: when the reply is ready the clip is allowed to
 *    finish (at most `maxTailMs` more), and the reply is fetched in parallel
 *    with that tail, so the tail costs the person almost nothing;
 *  - it plays on the same audio element the call already unlocked inside the
 *    tap, which is what Safari on iOS requires for sound that starts later.
 *
 * Timers and the audio element are injected so the behaviour is testable
 * without a browser.
 */

export const FILLER_CLIPS = ['/voice/wait-1.mp3', '/voice/wait-2.mp3', '/voice/wait-3.mp3'] as const;
/** A reply that arrives faster than this plays no filler. */
export const FILLER_DELAY_MS = 400;
/** The longest the reply waits for a clip to finish (the clips run 1.4 to 1.9 seconds). */
export const FILLER_MAX_TAIL_MS = 1800;

export type FillerAudio = {
  src: string;
  volume: number;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
  play(): Promise<void>;
  pause(): void;
};

export type FillerOptions = {
  getAudio: () => FillerAudio | null;
  clips?: readonly string[];
  delayMs?: number;
  maxTailMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  now?: () => number;
};

export type Filler = {
  /** Arms the delay; the clip begins when it runs out. Calling it twice does nothing. */
  start(): void;
  /**
   * The reply is ready. Resolves once the clip is no longer playing, with the
   * milliseconds spent waiting for it (0 when no clip was playing).
   */
  finish(): Promise<number>;
  /** The turn was cut off or failed: silence the clip now and forget it. */
  cancel(): void;
};

type Status = 'new' | 'waiting' | 'playing' | 'done';

let rotation = 0;

export function createFiller(options: FillerOptions): Filler {
  const clips = options.clips ?? FILLER_CLIPS;
  const delayMs = options.delayMs ?? FILLER_DELAY_MS;
  const maxTailMs = options.maxTailMs ?? FILLER_MAX_TAIL_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => performance.now());

  let status: Status = 'new';
  let audio: FillerAudio | null = null;
  let delayTimer: unknown = null;
  let tailTimer: unknown = null;
  let waiter: ((waitedMs: number) => void) | null = null;
  let waitStartedAt = 0;

  const detach = () => {
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
  };

  const settle = () => {
    if (tailTimer !== null) clearTimer(tailTimer);
    tailTimer = null;
    const resolve = waiter;
    waiter = null;
    resolve?.(Math.max(0, Math.round(now() - waitStartedAt)));
  };

  const clipEnded = () => {
    if (status !== 'playing') return;
    status = 'done';
    detach();
    settle();
  };

  const begin = () => {
    delayTimer = null;
    if (status !== 'waiting') return;
    audio = options.getAudio();
    if (!audio || clips.length === 0) {
      status = 'done';
      return;
    }
    status = 'playing';
    try {
      audio.src = clips[rotation++ % clips.length];
      audio.volume = 0.9;
      audio.onended = clipEnded;
      audio.onerror = clipEnded;
      // A browser that refuses sound without a tap just means no filler.
      void audio.play().catch(clipEnded);
    } catch {
      clipEnded();
    }
  };

  return {
    start() {
      if (status !== 'new') return;
      status = 'waiting';
      delayTimer = setTimer(begin, delayMs);
    },

    finish() {
      if (status === 'waiting') {
        if (delayTimer !== null) clearTimer(delayTimer);
        delayTimer = null;
        status = 'done';
        return Promise.resolve(0);
      }
      if (status !== 'playing') return Promise.resolve(0);
      return new Promise<number>((resolve) => {
        waiter = resolve;
        waitStartedAt = now();
        tailTimer = setTimer(() => {
          // A clip that has not ended by now is stuck: stop it and let the reply through.
          try {
            audio?.pause();
          } catch {
            // already stopped
          }
          clipEnded();
        }, maxTailMs);
      });
    },

    cancel() {
      if (delayTimer !== null) clearTimer(delayTimer);
      delayTimer = null;
      const wasPlaying = status === 'playing';
      status = 'done';
      if (wasPlaying) {
        try {
          audio?.pause();
        } catch {
          // already stopped
        }
      }
      detach();
      settle();
    },
  };
}
