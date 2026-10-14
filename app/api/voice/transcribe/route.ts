import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { buildVoiceDeps, resolveVoiceAccountKey, voiceJson, withProviderTiming } from '@/lib/ai/voice-route-deps';
import { transcribeVoiceTurn } from '@/lib/ai/voice-server';
import { createStageTimer, logVoiceTiming, takeColdStart } from '@/lib/ai/voice-timing';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Wake-up call the browser sends when a call starts. It does nothing and
 * checks nothing: its only job is to make Vercel start this function now, so
 * the first real question does not pay the cold start. No account, no
 * provider, no cost.
 */
export function GET() {
  takeColdStart();
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * One recorded question in, text and a single-use turn ticket out. The audio
 * is forwarded to the speech provider and never written anywhere by us.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const timer = createStageTimer();
  const cold = takeColdStart();
  const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  const mime = (req.headers.get('content-type') ?? '').trim();
  const sessionToken = req.headers.get('x-voice-session');
  const deps = await timer.time('deps', () => buildVoiceDeps(req));
  deps.provider = withProviderTiming(deps.provider, timer);

  const finish = (response: Response) => {
    logVoiceTiming('transcribe', { status: response.status, cold, totalMs: timer.totalMs, stages: timer.snapshot() });
    response.headers.set('Server-Timing', timer.serverTiming());
    return response;
  };

  // Off, signed out or unentitled: the handler answers before any account lookup.
  let accountKey = '-';
  if (deps.config.enabled && deps.user && deps.planAssistantDailyLimit) {
    const account = await timer.time('account', () => resolveVoiceAccountKey(deps, req));
    if (!account.ok) return finish(account.response);
    accountKey = account.key;
  }
  // The handler reads the body only after the cheap gates pass.
  const result = await transcribeVoiceTurn(deps, {
    sessionToken,
    accountKey,
    mime,
    declaredBytes: Number.isFinite(declared) ? declared : null,
    readAudio: () => timer.time('upload', () => req.arrayBuffer()).catch(() => null),
  });
  return finish(voiceJson(result));
}
