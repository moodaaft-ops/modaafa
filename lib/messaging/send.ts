import { sendEmail } from '@/lib/notifications/email';
import { MAX_SEND_ATTEMPTS, MIN_GAP_BETWEEN_MESSAGES_MS } from '@/config/stage-followups';

/**
 * The one place a follow-up email goes out from.
 *
 * Guarantees, in this order:
 *   1. Opt-out: a user with messages_opt_out = true is never emailed.
 *   2. One message per person per day: if anything was SENT to this user in
 *      the last 24 hours (any template, any task) nothing goes out.
 *   3. A template is sent to a user at most once. The (user_id, template_key)
 *      unique index in message_log is the lock, so two overlapping cron runs
 *      cannot both send. A row left `failed` may be retried up to
 *      MAX_SEND_ATTEMPTS times in total.
 *
 * The caller decides WHAT to send and WHEN. This function decides whether it
 * is allowed to go out right now, and writes the audit row either way a send
 * was attempted. Opt-out and throttle skips write no row: they are re-checked
 * on the next run.
 */
export type SendRequest = {
  admin: any;
  userId: string;
  templateKey: string;
  stage?: string | null;
  subject: string;
  html: string;
  footerHtml?: string;
  headers?: Record<string, string>;
  now?: Date;
};

export type SendResult =
  | { status: 'sent'; providerId?: string }
  | { status: 'skipped'; reason: 'opted_out' | 'no_email' | 'daily_limit' | 'already_handled' | 'user_not_found' }
  | { status: 'not_configured' }
  | { status: 'failed'; reason: string };

export type SendDeps = {
  sendEmail: typeof sendEmail;
};

const defaultDeps: SendDeps = { sendEmail };

export async function send(request: SendRequest, deps: SendDeps = defaultDeps): Promise<SendResult> {
  const { admin, userId, templateKey } = request;
  const now = request.now ?? new Date();

  const { data: user, error: userError } = await admin
    .from('users')
    .select('email, messages_opt_out')
    .eq('id', userId)
    .maybeSingle();
  if (userError) return { status: 'failed', reason: `user_lookup_${userError.code ?? 'error'}` };
  if (!user) return { status: 'skipped', reason: 'user_not_found' };
  if (user.messages_opt_out === true) return { status: 'skipped', reason: 'opted_out' };
  if (!user.email) return { status: 'skipped', reason: 'no_email' };

  const since = new Date(now.getTime() - MIN_GAP_BETWEEN_MESSAGES_MS).toISOString();
  const { data: recent, error: recentError } = await admin
    .from('message_log')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'sent')
    .gte('sent_at', since)
    .limit(1)
    .maybeSingle();
  // If the log cannot be read we cannot prove the daily limit holds, so we
  // do not send. A missed follow-up is cheaper than a double one.
  if (recentError) return { status: 'failed', reason: `throttle_lookup_${recentError.code ?? 'error'}` };
  if (recent) return { status: 'skipped', reason: 'daily_limit' };

  const claimed = await claimTemplate(admin, userId, templateKey, request.stage ?? null, now);
  if (claimed === 'taken') return { status: 'skipped', reason: 'already_handled' };
  if (claimed === 'error') return { status: 'failed', reason: 'claim_failed' };

  try {
    const result = await deps.sendEmail({
      to: user.email,
      subject: request.subject,
      html: request.html,
      footerHtml: request.footerHtml,
      headers: request.headers,
    });
    if (!result.sent) {
      // Email is not configured in this environment. That is not the user's
      // fault and not an attempt: release the claim so the step can still go
      // out once the keys exist.
      await admin.from('message_log').delete().eq('user_id', userId).eq('template_key', templateKey).eq('status', 'pending');
      return { status: 'not_configured' };
    }
    await admin
      .from('message_log')
      .update({ status: 'sent', sent_at: now.toISOString(), provider_id: result.id ?? null, reason: null })
      .eq('user_id', userId)
      .eq('template_key', templateKey);
    return { status: 'sent', providerId: result.id };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : 'unknown').slice(0, 200);
    await admin
      .from('message_log')
      .update({ status: 'failed', reason })
      .eq('user_id', userId)
      .eq('template_key', templateKey);
    return { status: 'failed', reason };
  }
}

/**
 * Takes the (user, template) slot. First send inserts a `pending` row; a
 * retry flips a `failed` row with attempts left back to `pending`.
 */
async function claimTemplate(
  admin: any,
  userId: string,
  templateKey: string,
  stage: string | null,
  now: Date
): Promise<'claimed' | 'taken' | 'error'> {
  const { error } = await admin.from('message_log').insert({
    user_id: userId,
    channel: 'email',
    template_key: templateKey,
    stage,
    status: 'pending',
    attempts: 1,
    created_at: now.toISOString(),
  });
  if (!error) return 'claimed';
  if ((error as { code?: string }).code !== '23505') {
    console.error('[message_log] insert failed', { code: (error as { code?: string }).code });
    return 'error';
  }

  const { data: retried, error: retryError } = await admin
    .from('message_log')
    .select('id, attempts')
    .eq('user_id', userId)
    .eq('template_key', templateKey)
    .eq('status', 'failed')
    .lt('attempts', MAX_SEND_ATTEMPTS)
    .maybeSingle();
  if (retryError) return 'error';
  if (!retried) return 'taken';

  // Compare-and-set on the status so two runs cannot both retry.
  const { data: updated, error: updateError } = await admin
    .from('message_log')
    .update({ status: 'pending', attempts: retried.attempts + 1 })
    .eq('id', retried.id)
    .eq('status', 'failed')
    .select('id');
  if (updateError) return 'error';
  return updated && updated.length > 0 ? 'claimed' : 'taken';
}
