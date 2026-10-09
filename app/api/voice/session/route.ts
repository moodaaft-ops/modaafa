import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { SELECTED_ADS_ACCOUNT_COOKIE } from '@/lib/accounts/selection';
import { loadChatState } from '@/lib/chat-first/state';
import { buildVoiceDeps, voiceJson } from '@/lib/ai/voice-route-deps';
import { startVoiceSession } from '@/lib/ai/voice-server';

export const runtime = 'nodejs';

/**
 * Opens a call scoped to ONE ad account, resolved by the same function the
 * chat entry uses, so voice and chat can never disagree about which account a
 * turn belongs to. No provider is touched here.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const deps = await buildVoiceDeps(req);
  // Off, signed out, or no entitlement: the handler answers before any account lookup.
  if (!deps.config.enabled || !deps.user || !deps.planAssistantDailyLimit) {
    return voiceJson(await startVoiceSession(deps));
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const loaded = await loadChatState({
    supabase: deps.supabase,
    userId: deps.user.id,
    userEmail: deps.user.email,
    requestedCustomerId: typeof body.customerId === 'string' ? body.customerId : null,
    cookieCustomerId: req.cookies.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? null,
  });
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error === 'account_not_found' ? 'account_not_found' : 'security_service_unavailable' }, { status: loaded.error === 'account_not_found' ? 404 : 503 });
  }
  return voiceJson(await startVoiceSession(deps, loaded.accountId ?? '-'));
}
