import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { readVoiceConfig, validateTtsText, VOICE_LIMITS } from '@/lib/ai/voice-session';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Text to speech proxy. The ElevenLabs key lives only in this server process;
 * the browser receives audio bytes and nothing else. Same gating order as the
 * text assistant: origin, session, subscription, rate limit. The text is
 * never stored or logged, and no audio is kept.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }

  const config = readVoiceConfig();
  // Off means off: the same answer whether the flag is false or the key is missing.
  if (!config.enabled || !config.apiKey || !config.voiceId) {
    return NextResponse.json({ error: 'voice_unavailable' }, { status: 404 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const subscription = await getSubscriptionAccess(supabase, user.id, user.email);
  if (!subscription.active) {
    return NextResponse.json({ error: 'subscription_required' }, { status: 402 });
  }

  try {
    const rateLimit = await checkRateLimit({
      req,
      scope: 'voice_tts',
      limit: VOICE_LIMITS.ttsRequestsPerWindow,
      windowSeconds: VOICE_LIMITS.ttsWindowSeconds,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const checked = validateTtsText(body?.text);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: checked.status });
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/stream?output_format=mp3_44100_64`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: checked.text,
          model_id: config.modelId,
          language_code: 'ar',
        }),
        // The browser closing the connection (cut / end call) stops the upstream too.
        signal: req.signal,
      }
    );
  } catch {
    return NextResponse.json({ error: 'voice_upstream_unreachable' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    // Never forward the provider's body: it can echo account details.
    const status = upstream.status === 401 || upstream.status === 403 ? 503 : upstream.status === 429 ? 429 : 502;
    return NextResponse.json({ error: 'voice_upstream_failed' }, { status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}
