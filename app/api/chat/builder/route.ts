import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { getCustomer } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import { buildCampaign } from '@/lib/ai/builder-agent';

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
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { brief, customerId, sessionId } = await req.json();
  if (!brief || !customerId) {
    return NextResponse.json({ error: 'brief and customerId required' }, { status: 400 });
  }

  // Get the linked account
  const { data: account } = await supabase
    .from('google_ads_accounts')
    .select('id, refresh_token_encrypted, business_id, businesses(name, sector, website)')
    .eq('customer_id', customerId)
    .single();

  if (!account) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });

  // Get or create chat session
  let chatSessionId = sessionId;
  if (!chatSessionId) {
    const { data: newSession } = await supabase
      .from('chat_sessions')
      .insert({
        user_id: user.id,
        account_id: account.id,
        title: brief.slice(0, 60),
      })
      .select('id')
      .single();
    chatSessionId = newSession!.id;
  }

  // Log user message
  await supabase.from('chat_messages').insert({
    session_id: chatSessionId,
    role: 'user',
    content: brief,
  });

  try {
    const refreshToken = decrypt(account.refresh_token_encrypted);
    const customer = getCustomer(customerId, refreshToken);

    const business = (account as any).businesses;
    const result = await buildCampaign(brief, customer, {
      business_name: business?.name,
      sector: business?.sector,
      website: business?.website,
    });

    // Persist the draft
    await supabase
      .from('chat_sessions')
      .update({ draft_campaign: result.draft_campaign })
      .eq('id', chatSessionId);

    // Log assistant message + tool trace
    await supabase.from('chat_messages').insert({
      session_id: chatSessionId,
      role: 'assistant',
      content: result.summary_ar,
      tool_calls: result.tool_trace as any,
    });

    return NextResponse.json({
      session_id: chatSessionId,
      draft_campaign: result.draft_campaign,
      summary_ar: result.summary_ar,
      next_steps_ar: result.next_steps_ar,
    });
  } catch (err) {
    console.error('Builder failed', err);
    return NextResponse.json(
      { error: 'builder_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
