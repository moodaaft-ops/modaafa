import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { buildVoiceDeps, voiceJson } from '@/lib/ai/voice-route-deps';
import { endVoiceSession } from '@/lib/ai/voice-server';

export const runtime = 'nodejs';

/**
 * Ends a call on the server: writes the end marker to the shared limits store
 * so the session token and every ticket issued under it stop working on every
 * instance, even if the browser is gone. Idempotent. Never touches the provider.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const deps = await buildVoiceDeps(req);
  return voiceJson(await endVoiceSession(deps, { sessionToken: req.headers.get('x-voice-session') }));
}
