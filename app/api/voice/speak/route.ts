import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { buildVoiceDeps, resolveVoiceAccountKey, voiceJson } from '@/lib/ai/voice-route-deps';
import { speakVoiceTurn } from '@/lib/ai/voice-server';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Text to speech. Works only against a single-use turn ticket that
 * /api/voice/transcribe issued after a real recorded question, so calling this
 * endpoint directly with arbitrary text gets a 403 and never reaches the
 * provider. The provider key stays in this server process.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const deps = await buildVoiceDeps(req);
  let accountKey = '-';
  if (deps.config.enabled && deps.user && deps.planAssistantDailyLimit) {
    const account = await resolveVoiceAccountKey(deps, req);
    if (!account.ok) return account.response;
    accountKey = account.key;
  }
  return voiceJson(
    await speakVoiceTurn(deps, {
      ticket: typeof body?.ticket === 'string' ? body.ticket : req.headers.get('x-voice-ticket'),
      text: body?.text,
      signal: req.signal,
      accountKey,
    })
  );
}
