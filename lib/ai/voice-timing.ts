/**
 * Per-stage timing for the voice call. Nothing here touches a request body, a
 * transcript or a reply: only stage names and milliseconds, so a log line can
 * be read to find where a slow turn spent its time without exposing what was
 * said.
 *
 * One turn crosses three routes (transcribe, chat/start, speak). Each route
 * writes one `[voice-timing]` line with its own stages; the browser adds the
 * stages it measured itself (speech-to-text wait, chat wait) as a request
 * header on the speak call, so the last line of a turn carries the whole story.
 */

export type StageTimer = ReturnType<typeof createStageTimer>;

/** Stage names must stay token-safe: they are also written into a Server-Timing header. */
const STAGE_NAME = /^[a-z][a-z0-9_]{0,23}$/;

const round = (ms: number) => Math.max(0, Math.round(ms));

export function createStageTimer(now: () => number = () => performance.now()) {
  const startedAt = now();
  const stages: Record<string, number> = {};

  const add = (name: string, ms: number) => {
    if (!STAGE_NAME.test(name)) return;
    // The same stage twice (two model calls) adds up; the per-call list is kept separately where it matters.
    stages[name] = round((stages[name] ?? 0) + ms);
  };

  return {
    /** Runs `work`, records its duration under `name` even when it throws. */
    async time<T>(name: string, work: () => Promise<T>): Promise<T> {
      const t = now();
      try {
        return await work();
      } finally {
        add(name, now() - t);
      }
    },
    add,
    get totalMs() {
      return round(now() - startedAt);
    },
    snapshot(): Record<string, number> {
      return { ...stages };
    },
    /** `Server-Timing` header value, so the browser's network panel shows the same numbers. */
    serverTiming(): string {
      const parts = Object.entries(stages).map(([name, ms]) => `${name};dur=${ms}`);
      parts.push(`total;dur=${round(now() - startedAt)}`);
      return parts.join(', ');
    },
  };
}

let instanceWarm = false;

/** True once per server instance: the first request an instance serves pays the cold start. */
export function takeColdStart(): boolean {
  if (instanceWarm) return false;
  instanceWarm = true;
  return true;
}

/** Test seam only. */
export function resetColdStartForTests() {
  instanceWarm = false;
}

export type VoiceTimingRoute = 'transcribe' | 'chat' | 'speak';

/** One structured line per route call. Vercel keeps the last hour of these, enough for a test call. */
export function logVoiceTiming(
  route: VoiceTimingRoute,
  fields: { status: number; cold: boolean; totalMs: number; stages: Record<string, number>; extra?: Record<string, unknown> },
  log: (line: string) => void = (line) => console.info(line)
) {
  try {
    log(
      `[voice-timing] ${JSON.stringify({
        route,
        status: fields.status,
        cold: fields.cold,
        total_ms: fields.totalMs,
        ...fields.stages,
        ...(fields.extra ?? {}),
      })}`
    );
  } catch {
    // Timing must never be the reason a voice turn fails.
  }
}

/** The stages the browser may report about its own wait, nothing else gets through. */
const CLIENT_STAGES = ['stt', 'chat', 'filler', 'prev_audio'] as const;
export const CLIENT_TIMING_HEADER = 'x-voice-client-ms';
const CLIENT_MAX_MS = 120_000;

/** Header value like `stt=1840,chat=6210`. Unknown names and non-numbers are dropped. */
export function parseClientTimings(header: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!header || header.length > 200) return out;
  for (const part of header.split(',')) {
    const [name, raw] = part.trim().split('=');
    if (!name || raw === undefined) continue;
    if (!(CLIENT_STAGES as readonly string[]).includes(name)) continue;
    if (!/^\d{1,6}$/.test(raw)) continue;
    const value = Number.parseInt(raw, 10);
    if (value <= CLIENT_MAX_MS) out[`c_${name}`] = value;
  }
  return out;
}

export function formatClientTimings(stages: Partial<Record<(typeof CLIENT_STAGES)[number], number>>): string {
  return CLIENT_STAGES.filter((name) => Number.isFinite(stages[name]))
    .map((name) => `${name}=${round(stages[name] as number)}`)
    .join(',');
}
