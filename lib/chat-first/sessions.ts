/**
 * Session scoping for the chat-first entry. A session belongs to ONE user AND
 * ONE ad account. The same user on account B must never read or continue
 * account A's conversation, and a foreign or unknown id is indistinguishable
 * from a missing one.
 */

export async function sessionBelongsTo(args: {
  supabase: any;
  userId: string;
  sessionId: string;
  accountId: string | null;
}): Promise<boolean> {
  const { data: s } = await args.supabase
    .from('chat_sessions')
    .select('id, account_id')
    .eq('id', args.sessionId)
    .eq('user_id', args.userId)
    .maybeSingle();
  return Boolean(s) && (s.account_id ?? null) === (args.accountId ?? null);
}

export type HistoryResult =
  | { found: false }
  | { found: true; sessionId: string; messages: Array<Record<string, any>> };

export async function loadScopedHistory(args: {
  supabase: any;
  userId: string;
  accountId: string | null;
  wantedSessionId: string | null;
}): Promise<HistoryResult> {
  const { supabase, userId, accountId, wantedSessionId } = args;
  let query = supabase.from('chat_sessions').select('id').eq('user_id', userId);
  query = accountId ? query.eq('account_id', accountId) : query.is('account_id', null);
  query = wantedSessionId
    ? query.eq('id', wantedSessionId)
    : query.order('updated_at', { ascending: false }).limit(1);
  const { data: rows } = await query;
  const session = rows?.[0];
  if (!session) return { found: false };
  const { data: messages } = await supabase
    .from('chat_messages')
    .select('role, content, tool_results, seq')
    .eq('session_id', session.id)
    .order('seq', { ascending: true })
    .limit(200);
  // Old turns are history: their buttons are never replayed.
  const history = (messages ?? []).map((m: any) => ({
    ...m,
    tool_results: m.tool_results ? { ...m.tool_results, actions: [] } : m.tool_results,
  }));
  return { found: true, sessionId: session.id, messages: history };
}

export type RecentChat = { id: string; title: string };

/**
 * The sidebar's list of past conversations: this user's sessions on the
 * selected ad account only, newest first. A read error is an empty list, never
 * a broken page.
 */
export async function listRecentChats(args: {
  supabase: any;
  userId: string;
  accountId: string | null;
  limit?: number;
}): Promise<RecentChat[]> {
  if (!args.accountId) return [];
  try {
    const { data, error } = await args.supabase
      .from('chat_sessions')
      .select('id, title')
      .eq('user_id', args.userId)
      .eq('account_id', args.accountId)
      .order('updated_at', { ascending: false })
      .limit(args.limit ?? 30);
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((row: any) => typeof row?.id === 'string')
      .map((row: any) => ({ id: row.id, title: String(row.title ?? '').trim() || 'محادثة' }));
  } catch {
    return [];
  }
}
