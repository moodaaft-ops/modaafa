/**
 * Counts one click on a message_log row (user, email channel, template key).
 * The first click time is kept; the counter goes up every time. A click on a
 * message with no log row (a billing mail, which is not logged) is ignored.
 */
export async function recordClick(admin: any, userId: string, templateKey: string, now: Date = new Date()) {
  const { data: row, error } = await admin
    .from('message_log')
    .select('id, clicked_at, click_count')
    .eq('user_id', userId)
    .eq('channel', 'email')
    .eq('template', templateKey)
    .maybeSingle();
  if (error) throw new Error(`click lookup failed: ${error.message ?? 'unknown'}`);
  if (!row) return { recorded: false as const };

  const stamp = now.toISOString();
  const { error: updateError } = await admin
    .from('message_log')
    .update({
      clicked_at: row.clicked_at ?? stamp,
      click_count: (typeof row.click_count === 'number' ? row.click_count : 0) + 1,
    })
    .eq('id', row.id);
  if (updateError) throw new Error(`click update failed: ${updateError.message ?? 'unknown'}`);
  return { recorded: true as const };
}
