import type { NextRequest } from 'next/server';
import { createChatSessionHandlers } from '@/lib/chat-first/session-routes';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { createServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const handlers = createChatSessionHandlers({ createServerClient, checkRateLimit, rateLimitHeaders });

/** Rename a conversation: body `{ title }`, 1 to 80 characters. */
export function PATCH(req: NextRequest, ctx: Context) {
  return handlers.PATCH(req, ctx);
}

/** Delete a conversation and, by cascade, its messages. */
export function DELETE(req: NextRequest, ctx: Context) {
  return handlers.DELETE(req, ctx);
}
