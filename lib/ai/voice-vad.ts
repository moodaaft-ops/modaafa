/**
 * Energy based voice activity detection for the hands-free call.
 * Pure and clock-injected so end-of-turn behaviour can be tested without a
 * microphone. The panel feeds it one RMS sample (0..1) every ~50ms.
 *
 * This is deliberately simple: it separates "someone is talking" from "room
 * noise" using an adaptive floor. It cannot tell a person from a TV, and on
 * speakerphone it can hear the assistant's own voice, which is why barge-in
 * uses a stricter profile.
 */

export type VadOptions = {
  /** Loud enough for this long counts as the start of speech. */
  startMs: number;
  /** Quiet for this long after speech counts as the end of the turn. */
  endSilenceMs: number;
  /** Shorter bursts than this are treated as noise (a cough, a tap). */
  minSpeechMs: number;
  /** Absolute floor for the threshold. */
  minThreshold: number;
  /** Threshold = max(minThreshold, noiseFloor * floorMultiplier). */
  floorMultiplier: number;
  /** A single turn never runs longer than this. */
  maxUtteranceMs: number;
  /** First samples after reset are used to learn the room noise. */
  calibrationMs: number;
};

export const LISTEN_VAD: VadOptions = {
  startMs: 150,
  endSilenceMs: 1100,
  minSpeechMs: 450,
  minThreshold: 0.02,
  floorMultiplier: 3,
  maxUtteranceMs: 28_000,
  calibrationMs: 400,
};

/** Stricter profile while the assistant is talking, so its own echo rarely cuts it off. */
export const BARGE_VAD: VadOptions = {
  ...LISTEN_VAD,
  startMs: 300,
  minThreshold: 0.06,
  floorMultiplier: 4,
};

export type VadEvent = 'none' | 'speech_start' | 'speech_end' | 'speech_cancel' | 'too_long';

export function createVad(options: VadOptions) {
  let floor = 0;
  let startedAt: number | null = null;
  let calibrated = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;
  let speechStart: number | null = null;
  let lastVoiceAt = 0;

  const threshold = () => Math.max(options.minThreshold, floor * options.floorMultiplier);

  return {
    reset() {
      startedAt = null;
      calibrated = false;
      aboveSince = null;
      belowSince = null;
      speechStart = null;
      lastVoiceAt = 0;
    },
    /** Start already calibrated (barge-in: the person is mid-word, there is no quiet to learn from). */
    seed(noiseFloor: number) {
      floor = noiseFloor;
      calibrated = true;
      startedAt = 0;
    },
    /** Treat speech as already under way from `nowMs`. */
    forceSpeech(nowMs: number) {
      speechStart = nowMs;
      lastVoiceAt = nowMs;
    },
    get noiseFloor() {
      return floor;
    },
    get speaking() {
      return speechStart !== null;
    },
    get threshold() {
      return threshold();
    },
    push(rms: number, nowMs: number): VadEvent {
      if (startedAt === null) startedAt = nowMs;
      if (!calibrated) {
        // Learn the room while nobody is expected to talk yet.
        floor = floor === 0 ? rms : floor * 0.7 + rms * 0.3;
        if (nowMs - startedAt >= options.calibrationMs) calibrated = true;
        return 'none';
      }

      const loud = rms > threshold();

      if (speechStart === null) {
        if (loud) {
          belowSince = null;
          if (aboveSince === null) aboveSince = nowMs;
          if (nowMs - aboveSince >= options.startMs) {
            speechStart = aboveSince;
            lastVoiceAt = nowMs;
            return 'speech_start';
          }
        } else {
          // Tolerate a short dip inside a syllable before forgetting the onset.
          if (belowSince === null) belowSince = nowMs;
          if (nowMs - belowSince > 120) aboveSince = null;
          floor = floor * 0.95 + rms * 0.05;
        }
        return 'none';
      }

      // Inside speech: a softer bar keeps a trailing syllable from ending the turn.
      if (rms > threshold() * 0.7) lastVoiceAt = nowMs;
      if (nowMs - speechStart >= options.maxUtteranceMs) return 'too_long';
      if (nowMs - lastVoiceAt >= options.endSilenceMs) {
        const spoke = lastVoiceAt - speechStart;
        speechStart = null;
        aboveSince = null;
        belowSince = null;
        return spoke >= options.minSpeechMs ? 'speech_end' : 'speech_cancel';
      }
      return 'none';
    },
  };
}
