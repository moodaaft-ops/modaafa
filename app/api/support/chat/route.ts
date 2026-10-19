import { NextRequest, NextResponse } from 'next/server';
import { cachedSystemBlock, createMessageForAgent, hasAIBackend, supportBotTier } from '@/lib/ai/client';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { createServerClient } from '@/lib/supabase/server';
import { isSupportBotEnabled } from '@/lib/support/flag';
import { answerSupport, extractReplyInput, normalizeTurns, sanitizePage, supportToolChoice, type SupportModelCall } from '@/lib/support/bot';
import { supportBotHandoffUrl } from '@/lib/support/contact';

/**
 * Customer-service bot ("الدعم"). Open to visitors and to signed-in users, so
 * the limits are per IP and deliberately generous for shared mobile networks:
 * a burst window and a daily one. When anything fails the response still
 * carries a WhatsApp link, because the rule is that a customer is never left
 * with a dead chat.
 *
 * Nothing about the conversation is stored in this phase; only the usual
 * llm_usage cost row (feature `support_bot`) is written.
 */

const MAX_BODY_CHARS = 12_000;
const BURST = { limit: 20, windowSeconds: 300 };
const DAILY = { limit: 120, windowSeconds: 86_400 };

async function readSession(): Promise<{ id: string | null; email: string | null }> {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { id: user?.id ?? null, email: user?.email ?? null };
  } catch {
    return { id: null, email: null };
  }
}

function failure(status: number, error: string, summary?: string | null, extra?: Record<string, unknown>, headers?: HeadersInit) {
  return NextResponse.json(
    { error, handoff: true, whatsappUrl: supportBotHandoffUrl({ summary }), ...extra },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } }
  );
}

export async function POST(req: NextRequest) {
  if (!isSupportBotEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { messages?: unknown; page?: unknown };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'too_large' }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const turns = normalizeTurns(body?.messages);
  if (!turns) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const lastQuestion = [...turns].reverse().find((turn) => turn.role === 'user')?.content ?? null;

  if (!hasAIBackend()) return failure(503, 'support_unavailable', lastQuestion);

  try {
    const burst = await checkRateLimit({ req, scope: 'support_chat_burst', ...BURST });
    if (!burst.allowed) return failure(429, 'too_many_requests', lastQuestion, undefined, rateLimitHeaders(burst));
    const daily = await checkRateLimit({ req, scope: 'support_chat_day', ...DAILY });
    if (!daily.allowed) return failure(429, 'too_many_requests', lastQuestion, undefined, rateLimitHeaders(daily));
  } catch {
    return failure(503, 'security_service_unavailable', lastQuestion);
  }

  const session = await readSession();
  const page = sanitizePage(body?.page);

  const call: SupportModelCall = async ({ system, user, tool, maxTokens }) => {
    const response = await createMessageForAgent(
      'support',
      {
        max_tokens: maxTokens,
        system: cachedSystemBlock(system),
        tools: [tool],
        tool_choice: supportToolChoice(supportBotTier()),
        messages: [{ role: 'user', content: user }],
      },
      { timeout: 20_000, maxRetries: 1 },
      { userId: session.id, feature: 'support_bot', channel: 'text' }
    );
    return extractReplyInput(response);
  };

  try {
    const reply = await answerSupport({ turns, page, signedIn: Boolean(session.id) }, call);
    return NextResponse.json(
      {
        answer: reply.answer,
        handoff: reply.handoff,
        reason: reply.reason,
        link: reply.link,
        whatsappUrl: reply.handoff
          ? supportBotHandoffUrl({ summary: reply.summary, email: session.email, page })
          : null,
        assistantUrl: reply.reason === 'ad_performance' && session.id ? '/home' : null,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('support_chat_failed', { name: error instanceof Error ? error.name : 'unknown' });
    return failure(502, 'support_unavailable', lastQuestion);
  }
}
