/**
 * Replayed history shows proposal cards from earlier turns. Their buttons
 * must reflect the recommendation as it is NOW (applied, dismissed, still
 * pending), so the status is read again through the caller's RLS client.
 * Ids the caller cannot read simply get no status and render without buttons.
 */
const ROLLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function annotateProposalStatuses(supabase: any, messages: Array<Record<string, any>>) {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const card of message?.tool_results?.cards ?? []) {
      if (card?.kind === 'proposal' && typeof card.recommendationId === 'string') ids.add(card.recommendationId);
    }
  }
  if (ids.size === 0) return messages;

  const { data, error } = await supabase
    .from('recommendations')
    .select('id, status')
    .in('id', Array.from(ids).slice(0, 100));
  // On a read failure the cards stay as they were; the action route re-checks every press anyway.
  if (error) return messages;
  const statuses = new Map<string, string>();
  for (const row of data ?? []) statuses.set(row.id, row.status);

  // An applied proposal gets an undo button while its execution row can still
  // be rolled back (30 days, not already reverted). The rollback route checks
  // all of this again; this only decides whether to show the button.
  const undo = new Map<string, string>();
  const applied = Array.from(statuses.entries())
    .filter(([, status]) => status === 'applied')
    .map(([id]) => id);
  if (applied.length) {
    const since = new Date(Date.now() - ROLLBACK_WINDOW_MS).toISOString();
    const { data: actions } = await supabase
      .from('ai_actions')
      .select('id, recommendation_id, rollback_status, rollback_payload, execution_key, created_at')
      .in('recommendation_id', applied)
      .not('execution_key', 'is', null)
      .gte('created_at', since);
    for (const row of actions ?? []) {
      if (!row.rollback_status && row.rollback_payload && row.recommendation_id) undo.set(row.recommendation_id, row.id);
    }
  }

  return messages.map((message) => {
    const cards = message?.tool_results?.cards;
    if (!Array.isArray(cards) || !cards.some((card: any) => card?.kind === 'proposal')) return message;
    return {
      ...message,
      tool_results: {
        ...message.tool_results,
        cards: cards.map((card: any) =>
          card?.kind === 'proposal'
            ? {
                ...card,
                status: statuses.get(card.recommendationId) ?? 'dismissed',
                undoActionId: undo.get(card.recommendationId) ?? undefined,
              }
            : card
        ),
      },
    };
  });
}
