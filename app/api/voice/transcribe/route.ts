import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { buildVoiceDeps, voiceJson } from '@/lib/ai/voice-route-deps';
import { transcribeVoiceTurn } from '@/lib/ai/voice-server';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * One recorded question in, text and a single-use turn ticket out. The audio
 * is forwarded to the speech provider and never written anywhere by us.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  const mime = (req.headers.get('content-type') ?? '').trim();
  const sessionToken = req.headers.get('x-voice-session');
  const deps = await buildVoiceDeps(req);
  // The handler reads the body only after the cheap gates pass.
  return voiceJson(
    await transcribeVoiceTurn(deps, {
      sessionToken,
      mime,
      declaredBytes: Number.isFinite(declared) ? declared : null,
      readAudio: () => req.arrayBuffer().catch(() => null),
    })
  );
}
