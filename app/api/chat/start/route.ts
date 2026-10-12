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
import { loadScopedHistory, sessionBelongsTo } from '@/lib/chat-first/sessions';
import type { ModelCall } from '@/lib/chat-first/understand';
import { createMessageForAgent, hasAIBackend } from '@/lib/ai/client';
import { readVoiceConfig } from '@/lib/ai/voice-session';
import { grantSpeech, verifyChatVoiceTicket } from '@/lib/ai/voice-server';
import { voiceLimiter, voiceSessionStore } from '@/lib/ai/voice-route-deps';
import { isJarvisBrainEnabled } from '@/lib/jarvis/flag';
import { answerWithJarvis } from '@/lib/jarvis/turn';
import { annotateProposalStatuses } from '@/lib/jarvis/history';
import type { JarvisToolTrace } from '@/lib/jarvis/brain';

const MAX_MESSAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Intent classification only (max 450 tokens, no tools), so it runs on the
 * cheap fast tier. The user id is attached per request so the cost lands on the
 * right subscriber.
 */
const callAssistantModel =
  (userId: string, accountId: string | null, channel: 'text' | 'voice'): ModelCall =>
  async ({ system, user, maxTokens }) => {
    const response = await createMessageForAgent(
      'jarvis_fast',
      {
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
      undefined,
      { userId, accountId, feature: 'chat_start_language', channel }
    );
    return (
      response.content
        ?.filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n')
        .trim() ?? null
    );
  };

async function authed(req: NextRequest): Promise<{ res?: NextResponse; supabase?: any; user?: any }> {
  const notFound = { res: NextResponse.json({ error: 'not_found' }, { status: 404 }) as NextResponse };
  const mode = process.env.CHAT_FIRST_ENTRY;
  if (mode !== 'true' && mode !== 'operators') return notFound;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // In allowlist mode an outsider, signed in or not, sees the same 404 as when the flag is off.
  if (!user) return mode === 'true' ? { res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) } : notFound;
  if (!isChatFirstEnabled(process.env, user.email)) return notFound;
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

  // Owner AND account check on the session. A session is bound to the account
  // it was created for: the same user switching from account A to B must not
  // continue A's conversation (A's reports and cards would mix into B). A
  // foreign, unknown or other-account id all get the same 404.
  if (sessionId && !(await sessionBelongsTo({ supabase, userId: user.id, sessionId, accountId }))) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }

  // A spoken turn carries a ticket from /api/voice/transcribe. It must belong
  // to this user and THIS account, match this exact message, and works once.
  // It is checked before the language layer so a bad ticket never costs a model call.
  const voiceTicket = req.headers.get('x-voice-ticket');
  const voiceConfig = readVoiceConfig();
  let voiceCheck: Awaited<ReturnType<typeof verifyChatVoiceTicket>> | null = null;
  if (voiceTicket) {
    if (action || !message) return NextResponse.json({ error: 'ticket_invalid' }, { status: 403 });
    voiceCheck = await verifyChatVoiceTicket(
      { config: voiceConfig, nowMs: () => Date.now(), limit: voiceLimiter(req), sessions: voiceSessionStore(req, voiceConfig) },
      user.id,
      voiceTicket,
      message,
      accountId ?? '-'
    );
    if (!voiceCheck.ok) return NextResponse.json({ error: voiceCheck.error }, { status: voiceCheck.status });
  }

  let turn: ChatTurn;
  let sid = sessionId;
  let toolTrace: JarvisToolTrace[] | null = null;
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
  } else if (isJarvisBrainEnabled(user.email) && hasAIBackend()) {
    // Jarvis brain. The session is created first so a prepared change can point
    // back to the conversation it came from.
    if (!sid) sid = await createSession(supabase, user.id, accountId, userText).catch(() => null);
    try {
      const answer = await answerWithJarvis({
        supabase,
        user,
        accountId,
        state,
        message,
        channel: voiceCheck ? 'voice' : 'text',
        sessionId: sid,
      });
      if (answer.kind === 'budget_exhausted') {
        turn = planTurn(message, state);
        turn = {
          ...turn,
          reply: `${turn.reply}\n\n(وصلت حد التحليل الذكي لهذي الفترة. الأزرار والاعتماد والتراجع شغالة، والتحليل يرجع مع بداية اليوم أو الشهر الجديد.)`,
          actions: [...turn.actions, { label: 'شوف الباقات', action: { type: 'subscribe', href: '/billing' } }],
        };
        language = { source: 'rules', engine: 'jarvis', limited: { scope: state.subscriptionActive ? 'subscriber' : 'free', resetsAt: null } };
      } else {
        turn = answer.result.turn;
        toolTrace = answer.result.tools;
        language = { source: 'model', engine: 'jarvis', ...(answer.budget.level === 'degraded' ? { degraded: true } : {}) };
      }
    } catch (error) {
      console.error('jarvis brain failed, answering with rules', { name: error instanceof Error ? error.name : 'unknown' });
      turn = planTurn(message, state);
      language = { source: 'rules', engine: 'jarvis', degraded: true };
    }
  } else {
    const resolved = await resolveLanguage({
      message,
      state,
      hasBackend: hasAIBackend(),
      call: callAssistantModel(user.id, accountId ?? null, voiceCheck ? 'voice' : 'text'),
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

  // The spoken text is derived here from the final reply, so /api/voice/speak
  // can only ever play what this route produced for this ticket.
  const voiceGrant = () =>
    voiceCheck?.ok
      ? { voice: grantSpeech({ config: voiceConfig, nowMs: () => Date.now() }, user.id, voiceCheck, turn.spoken ?? turn.reply) }
      : {};

  try {
    if (!sid) sid = await createSession(supabase, user.id, accountId, userText);
    const { error: msgError } = await supabase.from('chat_messages').insert([
      { session_id: sid, role: 'user', content: userText },
      {
        session_id: sid,
        role: 'assistant',
        content: turn.reply,
        ...(toolTrace ? { tool_calls: toolTrace } : {}),
        tool_results: { cards: turn.cards, actions: turn.actions, intent: turn.intent },
      },
    ]);
    if (msgError) throw msgError;
  } catch (err) {
    console.error('chat-first persistence failed', err);
    // The answer is still correct; history just did not save.
    return NextResponse.json({ sessionId: sid, turn, saved: false, language, ...voiceGrant() });
  }
  return NextResponse.json({ sessionId: sid, turn, saved: true, language, ...voiceGrant() });
}

async function createSession(supabase: any, userId: string, accountId: string | null, title: string): Promise<string> {
  const { data: created, error } = await supabase
    .from('chat_sessions')
    .insert({ user_id: userId, account_id: accountId, title: title.slice(0, 60) })
    .select('id')
    .single();
  if (error) throw error;
  return created.id;
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if (a.res) return a.res;
  const { supabase, user } = a as { supabase: any; user: any };
  const wanted = req.nextUrl.searchParams.get('sessionId');
  if (wanted && !UUID.test(wanted)) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });

  // History is scoped to the selected account, never just the user.
  const loaded = await loadChatState({
    supabase,
    userId: user.id,
    userEmail: user.email,
    requestedCustomerId: req.nextUrl.searchParams.get('customerId'),
    cookieCustomerId: req.cookies.get(SELECTED_ADS_ACCOUNT_COOKIE)?.value ?? null,
  });
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.error === 'account_not_found' ? 404 : 503 });
  }
  const { accountId } = loaded;

  const result = await loadScopedHistory({ supabase, userId: user.id, accountId, wantedSessionId: wanted });
  if (!result.found) {
    return wanted
      ? NextResponse.json({ error: 'session_not_found' }, { status: 404 })
      : NextResponse.json({ sessionId: null, messages: [] });
  }
  const messages = await annotateProposalStatuses(supabase, result.messages);
  return NextResponse.json({ sessionId: result.sessionId, messages });
}
