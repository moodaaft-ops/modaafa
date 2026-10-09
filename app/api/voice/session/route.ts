import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { buildVoiceDeps, voiceJson } from '@/lib/ai/voice-route-deps';
import { startVoiceSession } from '@/lib/ai/voice-server';

export const runtime = 'nodejs';

/** Opens a call: returns a signed session token and the caps that apply to it. No provider is touched. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  return voiceJson(await startVoiceSession(await buildVoiceDeps(req)));
}
