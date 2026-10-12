import { createAdminClient } from '@/lib/supabase/server';
import { isEmailConfigured, sendEmail } from '@/lib/notifications/email';
import { TEMPLATES, type TemplateId } from './templates';

export type Channel = 'email' | 'whatsapp';

export type SendUser = {
  id: string;
  email: string;
  name?: string | null;
  messages_opt_out?: boolean | null;
};

export type SendResult =
  | { status: 'sent'; providerId?: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'not_configured' }
  | { status: 'channel_unsupported' };

export type SendDeps = {
  supabase?: any;
  sendEmail?: typeof sendEmail;
  emailConfigured?: () => boolean;
  now?: () => Date;
};

/**
 * One entry point for every outgoing customer message.
 *
 * Adding WhatsApp later means adding a branch in `deliver` below; claiming,
 * opt-out, logging and the funnel event all stay as they are.
 *
 * "Never twice": `claim_message` is an atomic insert against the unique
 * (user_id, channel, template) row in message_log, so two parallel callers
 * cannot both win. Resend also gets an Idempotency-Key as a second guard for
 * a crash between the provider call and the log update.
 */
export async function send(
  channel: Channel,
  template: TemplateId,
  user: SendUser,
  deps: SendDeps = {}
): Promise<SendResult> {
  const def = TEMPLATES[template];
  if (!def) return { status: 'failed', reason: 'unknown_template' };
  if (channel !== 'email') return { status: 'channel_unsupported' };

  const emailConfigured = deps.emailConfigured ?? isEmailConfigured;
  if (!emailConfigured()) return { status: 'not_configured' };

  const supabase = deps.supabase ?? createAdminClient();
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const rendered = def.renderEmail(user);
  if (!rendered) return { status: 'failed', reason: 'unsubscribe_secret_missing' };

  if (def.dailyLimit) {
    const since = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from('message_log')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'sent')
      .gte('sent_at', since)
      .limit(1)
      .maybeSingle();
    // If the log cannot be read the limit cannot be proven, so nothing goes
    // out. A missed follow-up costs less than a double one.
    if (recentError) return { status: 'failed', reason: 'daily_limit_lookup_failed' };
    if (recent) return { status: 'skipped', reason: 'daily_limit' };
  }

  const { data: claimed, error: claimError } = await supabase.rpc('claim_message', {
    p_user_id: user.id,
    p_channel: channel,
    p_template: template,
  });
  if (claimError) return { status: 'failed', reason: `claim_failed: ${claimError.message}`.slice(0, 300) };
  if (!claimed) return { status: 'duplicate' };

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from('message_log')
      .update({ ...patch, updated_at: now })
      .eq('user_id', user.id)
      .eq('channel', channel)
      .eq('template', template);
    if (error) console.error('message_log update failed', { userId: user.id, template, error });
  };

  if (user.messages_opt_out) {
    await finish({ status: 'skipped', reason: 'opted_out' });
    return { status: 'skipped', reason: 'opted_out' };
  }

  let providerId: string | undefined;
  try {
    const sender = deps.sendEmail ?? sendEmail;
    const result = await sender({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      footer: rendered.footer,
      headers: rendered.headers,
      replyTo: process.env.WELCOME_REPLY_TO_EMAIL?.trim() || undefined,
      idempotencyKey: `${template}-${user.id}`,
    });
    if (!result.sent) {
      const reason = ('reason' in result && result.reason) || 'not_sent';
      await finish({ status: 'failed', reason });
      return { status: 'failed', reason };
    }
    providerId = result.id;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await finish({ status: 'failed', reason });
    return { status: 'failed', reason };
  }

  await finish({ status: 'sent', sent_at: now, provider_id: providerId ?? null, reason: null });

  if (!def.sentEvent) return { status: 'sent', providerId };

  const { error: eventError } = await supabase.from('user_events').insert({
    user_id: user.id,
    event: def.sentEvent,
    stage: 'registered',
    metadata: { channel, template, provider_id: providerId ?? null },
  });
  // 23505 = already recorded (unique once-per-user index): fine.
  if (eventError && eventError.code !== '23505') {
    console.error('user_events insert failed', { userId: user.id, event: def.sentEvent, eventError });
  }

  return { status: 'sent', providerId };
}
