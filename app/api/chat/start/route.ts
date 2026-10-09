import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { SELECTED_ADS_ACCOUNT_COOKIE } from '@/lib/accounts/selection';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isChatFirstEnabled } from '@/lib/chat-first/flag';
import { loadChatState } from '@/lib/chat-first/state';
import { planApply, planTurn } from '@/lib/chat-first/orchestrator';
import { LANGUAGE_ALLOWANCE, type ChatLanguageMeta, type ChatTurn } from '@/lib/chat-first/contracts';
import { resolveLanguage } from '@/lib/chat-first/language';
import type { ModelCall } from '@/lib/chat-first/understand';
import { createMessageForAgent, hasAIBackend } from '@/lib/ai/client';

const MAX_MESSAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Existing model path (assistant role). No new model, no Opus. */
const callAssistantModel: ModelCall = async ({ system, user, maxTokens }) => {
  const response = await createMessageForAgent('assistant', {
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return (
    response.content
      ?.filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n')
      .trim() ?? null
  );
};

async function authed(req: NextRequest) {
  if (!isChatFirstEnabled()) return { res: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  try {
    const rl = await checkRateLimit({ req, scope: 'chat_start', limit: 60, windowSeconds: 60, identifier: user.id });
    if (!rl.allowed) {
      return { res: NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) }) };
    }
  } catch {
    return { res: NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 }) };
  }
  return { supabase, user };
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const a = await authed(req);
  if (a.res) return a.res;
  const { supabase, user } = a as { supabase: any; user: any };

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE) : '';
  const action = body.action && typeof body.action === 'object' ? body.action : null;
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
  if (!message && !action) return NextResponse.json({ error: 'message_required' }, { status: 400 });
  if (sessionId && !UUID.test(sessionId)) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });

  const loaded = await loadChatState({
    supabase,
    userId: user.id,
    userEmail: user.email,
    requestedCustomerId: typeof body.customerId === 'string' ? body.customerId : null,
    cookieCustomerId: req.cookies.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? null,
  });
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.error === 'account_not_found' ? 404 : 503 });
  }
  const { state, accountId } = loaded;

  // Owner check on the session: a foreign or unknown id is the same 404.
  if (sessionId) {
    const { data: s } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!s) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }

  let turn: ChatTurn;
  let userText = message;
  let language: ChatLanguageMeta = { source: 'rules' };
  if (action?.type === 'request_apply' || action?.type === 'show_recommendation') {
    // Recommendation ids are only resolved inside the caller's own loaded
    // state, so another account's recommendation id is simply not found.
    const rec = state.recommendations.find((r) => r.id === String(action.recommendationId ?? ''));
    if (!rec) return NextResponse.json({ error: 'recommendation_not_found' }, { status: 404 });
    if (action.type === 'request_apply') {
      turn = planApply(state, rec);
      userText = userText || 'أبي أطبق هذي التوصية';
    } else {
      turn = planTurn('وش التوصيات', state);
      userText = userText || 'وريني أهم توصية';
    }
  } else {
    const resolved = await resolveLanguage({
      message,
      state,
      hasBackend: hasAIBackend(),
      call: callAssistantModel,
      checkAllowance: async (scope) => {
        const r = await checkRateLimit({
          req,
          scope: `chat_start_language_${scope}`,
          limit: LANGUAGE_ALLOWANCE[scope],
          windowSeconds: LANGUAGE_ALLOWANCE.windowSeconds,
          identifier: user.id,
        });
        return { allowed: r.allowed, resetsAt: r.resetAt };
      },
    });
    language = resolved.meta;
    turn = planTurn(message, state, resolved.understood);
    if (resolved.meta.limited) {
      turn = {
        ...turn,
        reply: `${turn.reply}\n\n(وصلت حد الأسئلة الحرة لهذا اليوم، تبقى الأزرار والردود الجاهزة شغالة وترجع الأسئلة الحرة بعد التجديد.)`,
      };
    }
  }

  let sid = sessionId;
  try {
    if (!sid) {
      const { data: created, error } = await supabase
        .from('chat_sessions')
        .insert({ user_id: user.id, account_id: accountId, title: userText.slice(0, 60) })
        .select('id')
        .single();
      if (error) throw error;
      sid = created.id;
    }
    const { error: msgError } = await supabase.from('chat_messages').insert([
      { session_id: sid, role: 'user', content: userText },
      {
        session_id: sid,
        role: 'assistant',
        content: turn.reply,
        tool_results: { cards: turn.cards, actions: turn.actions, intent: turn.intent },
      },
    ]);
    if (msgError) throw msgError;
  } catch (err) {
    console.error('chat-first persistence failed', err);
    // The answer is still correct; history just did not save.
    return NextResponse.json({ sessionId: sid, turn, saved: false, language });
  }
  return NextResponse.json({ sessionId: sid, turn, saved: true, language });
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if (a.res) return a.res;
  const { supabase, user } = a as { supabase: any; user: any };
  const wanted = req.nextUrl.searchParams.get('sessionId');
  if (wanted && !UUID.test(wanted)) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });

  let query = supabase.from('chat_sessions').select('id').eq('user_id', user.id);
  query = wanted ? query.eq('id', wanted) : query.order('updated_at', { ascending: false }).limit(1);
  const { data: rows } = await query;
  const session = rows?.[0];
  if (!session) {
    return wanted
      ? NextResponse.json({ error: 'session_not_found' }, { status: 404 })
      : NextResponse.json({ sessionId: null, messages: [] });
  }
  const { data: messages } = await supabase
    .from('chat_messages')
    .select('role, content, tool_results, seq')
    .eq('session_id', session.id)
    .order('seq', { ascending: true })
    .limit(200);
  return NextResponse.json({ sessionId: session.id, messages: messages ?? [] });
}
