import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getCustomer } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import { buildCampaign } from '@/lib/ai/builder-agent';
import { getLinkedGoogleAdsAccount, normalizeCustomerId } from '@/lib/accounts/selection';
import {
  consumeFeatureUsage,
  featureAccessMessage,
  featureAccessStatus,
  refundFeatureUsage,
} from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';

/**
 * POST /api/chat/builder
 * Body: { brief: string, customerId: string, sessionId?: string }
 *
 * Returns: { draft_campaign, summary_ar, next_steps_ar }
 *
 * Persists the conversation in chat_sessions / chat_messages
 * and the resulting draft in chat_sessions.draft_campaign.
 */
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rateLimit = await checkRateLimit({ req, scope: 'campaign_builder', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const { brief, customerId, sessionId } = await req.json();
  const normalizedCustomerId = normalizeCustomerId(String(customerId ?? ''));
  if (!brief || !normalizedCustomerId) {
    return NextResponse.json({ error: 'brief and customerId required' }, { status: 400 });
  }

  const { account } = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId: normalizedCustomerId,
    select: 'id, customer_id, refresh_token_encrypted, manager_id, business_id, businesses(name, sector, website)',
  });

  if (!account) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });

  const usage = await consumeFeatureUsage({
    supabase,
    userId: user.id,
    feature: 'campaign_builder',
    accountId: account.id,
    metadata: { customer_id: account.customer_id },
  });
  if (!usage.ok) {
    return NextResponse.json(
      { error: usage.reason, message: featureAccessMessage(usage.reason), resets_at: usage.resetsAt },
      { status: featureAccessStatus(usage.reason) }
    );
  }

  try {
    // Get or create chat session
    let chatSessionId = sessionId;
    if (!chatSessionId) {
      const { data: newSession, error: sessionError } = await supabase
        .from('chat_sessions')
        .insert({
          user_id: user.id,
          account_id: account.id,
          title: brief.slice(0, 60),
        })
        .select('id')
        .single();
      if (sessionError || !newSession) throw sessionError ?? new Error('Failed to create chat session');
      chatSessionId = newSession.id;
    }

    const { error: userMessageError } = await supabase.from('chat_messages').insert({
      session_id: chatSessionId,
      role: 'user',
      content: brief,
    });
    if (userMessageError) throw userMessageError;

    const refreshToken = decrypt(account.refresh_token_encrypted);
    const customer = getCustomer(account.customer_id, refreshToken, account.manager_id ?? undefined);

    const business = (account as any).businesses;
    const result = await buildCampaign(brief, customer, {
      business_name: business?.name,
      sector: business?.sector,
      website: business?.website,
    });

    // Persist the draft
    const { error: draftError } = await supabase
      .from('chat_sessions')
      .update({ draft_campaign: result.draft_campaign })
      .eq('id', chatSessionId);
    if (draftError) throw draftError;

    // Log assistant message + tool trace
    const { error: assistantMessageError } = await supabase.from('chat_messages').insert({
      session_id: chatSessionId,
      role: 'assistant',
      content: result.summary_ar,
      tool_calls: result.tool_trace as any,
    });
    if (assistantMessageError) throw assistantMessageError;

    return NextResponse.json({
      session_id: chatSessionId,
      draft_campaign: result.draft_campaign,
      summary_ar: result.summary_ar,
      next_steps_ar: result.next_steps_ar,
      usage: { remaining: usage.remaining, resets_at: usage.resetsAt },
    });
  } catch (err) {
    await refundFeatureUsage({ supabase, userId: user.id, usageEventId: usage.usageEventId });
    console.error('Builder failed', err);
    return NextResponse.json(
      { error: 'builder_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
