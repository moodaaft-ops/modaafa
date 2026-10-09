import type { NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getSubscriptionAccess, PLAN_LIMITS } from '@/lib/billing/entitlements';
import { checkRateLimit, peekRateLimitWindow } from '@/lib/security/rate-limit';
import { SELECTED_ADS_ACCOUNT_COOKIE } from '@/lib/accounts/selection';
import { loadChatState } from '@/lib/chat-first/state';
import { readVoiceConfig } from '@/lib/ai/voice-session';
import {
  createElevenLabsProvider,
  createMockProvider,
  endMarkerWindowSeconds,
  type VoiceDeps,
  type VoiceResult,
  type VoiceSessions,
} from '@/lib/ai/voice-server';
import type { VoiceConfig } from '@/lib/ai/voice-session';
import { NextResponse } from 'next/server';

/** Wires the injectable voice handlers to Supabase, the rate limiter and the provider. */
export async function buildVoiceDeps(req: NextRequest): Promise<VoiceDeps & { supabase: any }> {
  const config = readVoiceConfig();
  const provider = config.provider === 'mock' ? createMockProvider(process.env.VOICE_MOCK_TRANSCRIPT) : createElevenLabsProvider(config);

  let user: VoiceDeps['user'] = null;
  let supabase: any = null;
  let planAssistantDailyLimit: number | null = null;
  let tier: VoiceDeps['tier'] = null;
  if (config.enabled) {
    supabase = await createServerClient();
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
    supabase,
    config,
    nowMs: () => Date.now(),
    user,
    planAssistantDailyLimit,
    tier,
    provider,
    sessions: voiceSessionStore(req, config),
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

/**
 * End markers live in the shared limits table (rate_limit_windows), the same
 * store every serverless instance already uses for the other voice counters.
 * `end` writes the marker (limit 1, so it is a single idempotent row); `isEnded`
 * reads it without consuming anything.
 */
export function voiceSessionStore(req: NextRequest, config: VoiceConfig): VoiceSessions {
  const windowSeconds = endMarkerWindowSeconds(config);
  return {
    async end(sessionId) {
      await checkRateLimit({ req, scope: 'voice_end', identifier: sessionId, limit: 1, windowSeconds });
    },
    async isEnded(sessionId) {
      const { count } = await peekRateLimitWindow({ scope: 'voice_end', identifier: sessionId, windowSeconds });
      return count > 0;
    },
  };
}

/**
 * The ad account this request is on, resolved by the same function the chat
 * entry uses. The browser may name the account it believes it is on; the
 * server only accepts it if it is linked to this user, and the call is bound
 * to whatever the server resolves, never to what the browser claims.
 */
export async function resolveVoiceAccountKey(
  deps: VoiceDeps & { supabase: any },
  req: NextRequest
): Promise<{ ok: true; key: string } | { ok: false; response: NextResponse }> {
  if (!deps.user) return { ok: true, key: '-' };
  const loaded = await loadChatState({
    supabase: deps.supabase,
    userId: deps.user.id,
    userEmail: deps.user.email,
    requestedCustomerId: req.headers.get('x-voice-customer'),
    cookieCustomerId: req.cookies.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? null,
  });
  if (!loaded.ok) {
    const notFound = loaded.error === 'account_not_found';
    return {
      ok: false,
      response: NextResponse.json(
        { error: notFound ? 'account_not_found' : 'security_service_unavailable' },
        { status: notFound ? 404 : 503, headers: { 'Cache-Control': 'no-store' } }
      ),
    };
  }
  return { ok: true, key: loaded.accountId ?? '-' };
}
