import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { buildVoiceDeps, resolveVoiceAccountKey, voiceJson, withProviderTiming } from '@/lib/ai/voice-route-deps';
import { speakVoiceTurn } from '@/lib/ai/voice-server';
import { CLIENT_TIMING_HEADER, createStageTimer, logVoiceTiming, parseClientTimings, takeColdStart } from '@/lib/ai/voice-timing';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Wake-up call, same idea as the one on /api/voice/transcribe: no account, no provider, no cost. */
export function GET() {
  takeColdStart();
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Text to speech. Works only against a single-use turn ticket that
 * /api/voice/transcribe issued after a real recorded question, so calling this
 * endpoint directly with arbitrary text gets a 403 and never reaches the
 * provider. The provider key stays in this server process.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const timer = createStageTimer();
  const cold = takeColdStart();
  // Only the four whitelisted millisecond counts survive; see parseClientTimings.
  const clientStages = parseClientTimings(req.headers.get(CLIENT_TIMING_HEADER));
  const body = await req.json().catch(() => ({}));
  const deps = await timer.time('deps', () => buildVoiceDeps(req));
  deps.provider = withProviderTiming(deps.provider, timer);

  const finish = (response: Response) => {
    logVoiceTiming('speak', {
      status: response.status,
      cold,
      totalMs: timer.totalMs,
      stages: timer.snapshot(),
      extra: clientStages,
    });
    response.headers.set('Server-Timing', timer.serverTiming());
    return response;
  };

  let accountKey = '-';
  if (deps.config.enabled && deps.user && deps.planAssistantDailyLimit) {
    const account = await timer.time('account', () => resolveVoiceAccountKey(deps, req));
    if (!account.ok) return finish(account.response);
    accountKey = account.key;
  }
  const result = await speakVoiceTurn(deps, {
    ticket: typeof body?.ticket === 'string' ? body.ticket : req.headers.get('x-voice-ticket'),
    text: body?.text,
    signal: req.signal,
    accountKey,
  });
  return finish(voiceJson(result));
}
