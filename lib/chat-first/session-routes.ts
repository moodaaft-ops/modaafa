import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import type { RateLimitResult } from '@/lib/security/rate-limit';
import { CHAT_SESSION_ID, parseChatTitle } from './session-manage';

type RouteContext = { params: Promise<{ id: string }> };

type Guarded =
  | { ok: false; response: NextResponse }
  | { ok: true; supabase: any; user: { id: string }; id: string };

export type ChatSessionRouteDeps = {
  createServerClient: () => Promise<any>;
  checkRateLimit: (args: {
    req: NextRequest;
    scope: string;
    limit: number;
    windowSeconds: number;
    identifier?: string | null;
  }) => Promise<RateLimitResult>;
  rateLimitHeaders: (result: RateLimitResult) => Record<string, string>;
};

/**
 * Rename and delete one conversation from the sidebar.
 *
 * The caller's own Supabase client does the write, so row level security
 * (`chat_sessions_owner_only`) is the first fence; the `user_id` filter is the
 * second. A conversation that is missing and one that belongs to someone else
 * both come back as 404. Deleting a session cascades to its messages.
 */
export function createChatSessionHandlers(deps: ChatSessionRouteDeps) {
  async function guard(req: NextRequest, ctx: RouteContext): Promise<Guarded> {
    // Defence in depth against cross-site writes; see lib/security/origin.ts.
    if (!isSameOriginRequest(req)) {
      return { ok: false, response: NextResponse.json({ error: 'invalid_origin' }, { status: 403 }) };
    }

    const supabase = await deps.createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };

    try {
      const limit = await deps.checkRateLimit({
        req,
        scope: 'chat_session_manage',
        limit: 60,
        windowSeconds: 60,
        identifier: user.id,
      });
      if (!limit.allowed) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: 'too_many_requests' },
            { status: 429, headers: deps.rateLimitHeaders(limit) },
          ),
        };
      }
    } catch {
      return { ok: false, response: NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 }) };
    }

    const { id } = await ctx.params;
    if (!CHAT_SESSION_ID.test(id)) {
      return { ok: false, response: NextResponse.json({ error: 'invalid_id' }, { status: 400 }) };
    }
    return { ok: true, supabase, user, id };
  }

  async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
    const checked = await guard(req, ctx);
    if (!checked.ok) return checked.response;
    const { supabase, user, id } = checked;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const title = parseChatTitle(body?.title);
    if (!title) return NextResponse.json({ error: 'invalid_title' }, { status: 400 });

    const { data, error } = await supabase
      .from('chat_sessions')
      .update({ title })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, title');
    if (error) {
      console.error('Failed to rename chat session', error);
      return NextResponse.json({ error: 'update_failed' }, { status: 500 });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id, title: String(data[0]?.title ?? title) });
  }

  async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
    const checked = await guard(req, ctx);
    if (!checked.ok) return checked.response;
    const { supabase, user, id } = checked;

    const { data, error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id');
    if (error) {
      console.error('Failed to delete chat session', error);
      return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  }

  return { PATCH, DELETE };
}
