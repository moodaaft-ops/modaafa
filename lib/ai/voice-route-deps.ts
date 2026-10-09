import type { NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getSubscriptionAccess, PLAN_LIMITS } from '@/lib/billing/entitlements';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { readVoiceConfig } from '@/lib/ai/voice-session';
import { createElevenLabsProvider, createMockProvider, type VoiceDeps, type VoiceResult } from '@/lib/ai/voice-server';
import { NextResponse } from 'next/server';

/** Wires the injectable voice handlers to Supabase, the rate limiter and the provider. */
export async function buildVoiceDeps(req: NextRequest): Promise<VoiceDeps> {
  const config = readVoiceConfig();
  const provider = config.provider === 'mock' ? createMockProvider(process.env.VOICE_MOCK_TRANSCRIPT) : createElevenLabsProvider(config);

  let user: VoiceDeps['user'] = null;
  let planAssistantDailyLimit: number | null = null;
  let tier: VoiceDeps['tier'] = null;
  if (config.enabled) {
    const supabase = await createServerClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    if (authUser) {
      user = { id: authUser.id, email: authUser.email ?? null };
      const subscription = await getSubscriptionAccess(supabase, authUser.id, authUser.email);
      if (subscription.active && subscription.plan) {
        planAssistantDailyLimit = PLAN_LIMITS[subscription.plan].assistant.limit;
        tier = 'paid';
      } else if (config.freeDailyTurns > 0) {
        // Not locked before the person has seen value (task 05 contract): a
        // small read-only allowance. Writes stay behind subscription, preview
        // and approval in the paths that perform them, not here.
        planAssistantDailyLimit = config.freeDailyTurns;
        tier = 'free';
      }
    }
  }

  return {
    config,
    nowMs: () => Date.now(),
    user,
    planAssistantDailyLimit,
    tier,
    provider,
    limit: async (key, limit, windowSeconds) => {
      const idx = key.indexOf(':');
      const result = await checkRateLimit({
        req,
        scope: key.slice(0, idx),
        identifier: key.slice(idx + 1),
        limit,
        windowSeconds,
      });
      return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
    },
  };
}

/** Rate-limit adapter shared by the chat route's voice check. */
export function voiceLimiter(req: NextRequest): VoiceDeps['limit'] {
  return async (key, limit, windowSeconds) => {
    const idx = key.indexOf(':');
    const result = await checkRateLimit({ req, scope: key.slice(0, idx), identifier: key.slice(idx + 1), limit, windowSeconds });
    return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
  };
}

export function voiceJson(result: VoiceResult) {
  if ('json' in result) {
    return NextResponse.json(result.json, {
      status: result.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return new Response(result.audio.body as BodyInit, {
    status: 200,
    headers: { 'Content-Type': result.audio.contentType, 'Cache-Control': 'no-store' },
  });
}
