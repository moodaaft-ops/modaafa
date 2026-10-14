import { createAdminClient } from '@/lib/supabase/server';
import { isEmailConfigured, sendEmail, type EmailTag } from '@/lib/notifications/email';
import type { EmailCopy, EmailFacts } from '@/lib/lifecycle/types';
import { isValidTemplateKey } from './links';
import { signingConfigured } from './opt-out';
import { isCategoryOn, loadPrefsRow, normalizePrefs } from './prefs';
import { renderTemplate } from './render';

export type SendUser = {
  id: string;
  email: string;
  name?: string | null;
  messages_opt_out?: boolean | null;
};

export type SendTemplateResult =
  | { status: 'sent'; providerId?: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'not_configured' };

export type SendDeps = {
  supabase?: any;
  sendEmail?: typeof sendEmail;
  emailConfigured?: () => boolean;
  now?: () => Date;
  /**
   * sendTemplate only: the user's preferences and suppression mark, when the
   * caller already loaded them (the lifecycle runner reads them in a batch).
   * Without it sendTemplate reads them itself, one query for the one user.
   */
  prefs?: {
    email_prefs?: unknown;
    messages_opt_out?: boolean | null;
    email_suppressed_at?: string | null;
  };
};

/** One non-transactional mail per person per this long (CONTRACT: MIN_GAP_MS). */
const GAP_MS = 24 * 60 * 60 * 1000;

/** Postgres undefined_column, or PostgREST's schema-cache miss for an unknown column. */
function isMissingColumn(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /column .* does not exist|could not find the .* column/i.test(error.message ?? '')
  );
}

type Outgoing = {
  subject: string;
  html: string;
  text?: string;
  footer?: string;
  headers: Record<string, string>;
  tags?: EmailTag[];
  /** html is a complete document from the brand shell. */
  rawHtml?: boolean;
};

type LogColumns = { category: string; copy_key: string };

/**
 * "Never twice": `claim_message` is an atomic insert against the unique
 * (user_id, channel, template) row in message_log, so two parallel callers
 * cannot both win.
 */
async function claim(
  supabase: any,
  userId: string,
  template: string
): Promise<{ ok: true } | { ok: false; result: SendTemplateResult }> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_message', {
    p_user_id: userId,
    p_channel: 'email',
    p_template: template,
  });
  if (claimError) {
    return { ok: false, result: { status: 'failed', reason: `claim_failed: ${claimError.message}`.slice(0, 300) } };
  }
  if (!claimed) return { ok: false, result: { status: 'duplicate' } };
  return { ok: true };
}

/**
 * Writes the outcome onto the claimed row. `columns` (category, copy_key) come
 * from the lifecycle migration; if the database does not have them yet the
 * write is repeated without them, because losing the status would leave the row
 * "sending" and the lease would let the same mail go out again.
 */
function outcomeWriter(supabase: any, now: string, userId: string, template: string, columns: LogColumns | null) {
  const write = (patch: Record<string, unknown>) =>
    supabase
      .from('message_log')
      .update(patch)
      .eq('user_id', userId)
      .eq('channel', 'email')
      .eq('template', template);

  return async (patch: Record<string, unknown>) => {
    let { error } = await write({ ...patch, ...(columns ?? {}), updated_at: now });
    if (error && columns && isMissingColumn(error)) {
      ({ error } = await write({ ...patch, updated_at: now }));
    }
    if (error) console.error('message_log update failed', { userId, template, error });
  };
}

async function recordSentEvent(supabase: any, userId: string, template: string, providerId: string | undefined) {
  const { error: eventError } = await supabase.from('user_events').insert({
    user_id: userId,
    event: 'welcome_email_sent',
    stage: 'registered',
    metadata: { channel: 'email', template, provider_id: providerId ?? null },
  });
  // 23505 = already recorded (unique once-per-user index): fine.
  if (eventError && eventError.code !== '23505') {
    console.error('user_events insert failed', { userId, event: 'welcome_email_sent', eventError });
  }
}

/**
 * Sends a claimed message and records the outcome. The one delivery step
 * behind `sendTemplate`, which every mail goes through: the welcome, the
 * lifecycle journeys, the weekly report, broadcasts and the Stripe mail.
 * There is no second send path that could skip the switches.
 */
async function deliverClaimed(args: {
  supabase: any;
  now: string;
  user: SendUser;
  template: string;
  outgoing: Outgoing;
  sender: typeof sendEmail;
  columns: LogColumns | null;
  sentEvent: 'welcome_email_sent' | null;
}): Promise<SendTemplateResult> {
  const { supabase, now, user, template, outgoing, sender, columns, sentEvent } = args;
  const finish = outcomeWriter(supabase, now, user.id, template, columns);

  let providerId: string | undefined;
  try {
    const result = await sender({
      to: user.email,
      subject: outgoing.subject,
      html: outgoing.html,
      ...(outgoing.text ? { text: outgoing.text } : {}),
      ...(outgoing.footer !== undefined ? { footer: outgoing.footer } : {}),
      headers: outgoing.headers,
      ...(outgoing.tags ? { tags: outgoing.tags } : {}),
      ...(outgoing.rawHtml ? { rawHtml: true } : {}),
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
  if (sentEvent) await recordSentEvent(supabase, user.id, template, providerId);
  return { status: 'sent', providerId };
}

export type SendTemplateInput = {
  user: SendUser;
  /** message_log template key: the copy key, or weekly_report_<year>-W<week>, or broadcast_<id>. */
  templateKey: string;
  copy: EmailCopy;
  facts: EmailFacts;
  /** Apply the one-optional-mail-per-24-hours rule. Transactional copies are never held back by it. */
  enforceGap: boolean;
};

/**
 * Sends one lifecycle or transactional mail from a copy.
 *
 * Checks, in this order, none of which touches the log until the last:
 *   not configured -> not_configured
 *   optional copy that is not approved -> skipped not_approved
 *   suppressed address -> skipped suppressed
 *   category off (preference or the one-click stop) -> skipped category_off
 *   optional mail within 24 h of another -> skipped min_gap (when enforceGap)
 *   no signing key for the stop link -> failed unsubscribe_secret_missing
 * then claims the (user, template) row, so a repeat call is `duplicate`, and
 * sends html and text together with Resend tags. The log row gets `category`
 * and `copy_key`. A copy that builds nothing for this user is logged as
 * skipped no_content so it is not tried again every run.
 */
export async function sendTemplate(input: SendTemplateInput, deps: SendDeps = {}): Promise<SendTemplateResult> {
  const { user, templateKey, copy, facts, enforceGap } = input;

  const emailConfigured = deps.emailConfigured ?? isEmailConfigured;
  if (!emailConfigured()) return { status: 'not_configured' };

  if (!isValidTemplateKey(templateKey)) return { status: 'failed', reason: 'bad_template_key' };

  const transactional = copy.category === 'transactional';
  // The texts are Ayman's to approve. Nothing optional goes out before he has.
  if (!transactional && !copy.approved) return { status: 'skipped', reason: 'not_approved' };

  let supabase: any;
  try {
    supabase = deps.supabase ?? createAdminClient();
  } catch {
    return { status: 'failed', reason: 'service_role_missing' };
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();

  let state: { prefs: ReturnType<typeof normalizePrefs>; optOut: boolean; suppressedAt: string | null };
  if (deps.prefs) {
    state = {
      prefs: normalizePrefs(deps.prefs.email_prefs),
      optOut: deps.prefs.messages_opt_out === true || user.messages_opt_out === true,
      suppressedAt: deps.prefs.email_suppressed_at ?? null,
    };
  } else {
    const loaded = await loadPrefsRow(supabase, user.id);
    if (!loaded.ok) return { status: 'failed', reason: `prefs_${loaded.reason}` };
    state = {
      prefs: loaded.row.email_prefs,
      optOut: loaded.row.messages_opt_out || user.messages_opt_out === true,
      suppressedAt: loaded.row.email_suppressed_at,
    };
  }

  // A bounced or complaining address gets nothing at all, billing mail included.
  if (state.suppressedAt) return { status: 'skipped', reason: 'suppressed' };
  if (!isCategoryOn(state.prefs, state.optOut, copy.category)) return { status: 'skipped', reason: 'category_off' };

  if (enforceGap && !transactional) {
    const since = new Date(new Date(now).getTime() - GAP_MS).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from('message_log')
      .select('id, category')
      .eq('user_id', user.id)
      .eq('channel', 'email')
      .eq('status', 'sent')
      .gte('sent_at', since)
      .limit(50);
    // If the log cannot be read the rule cannot be proven, so nothing goes out.
    if (recentError) return { status: 'failed', reason: 'gap_lookup_failed' };
    // Rows written before the lifecycle migration have no category and count as optional.
    const optionalRecent = ((recent ?? []) as Array<{ category?: string | null }>).some(
      (row) => row.category !== 'transactional'
    );
    if (optionalRecent) return { status: 'skipped', reason: 'min_gap' };
  }

  if (!transactional && !signingConfigured()) return { status: 'failed', reason: 'unsubscribe_secret_missing' };

  let rendered;
  try {
    rendered = renderTemplate({ copy, templateKey, user, facts });
  } catch (error) {
    return { status: 'failed', reason: `render_failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
  }

  const claimed = await claim(supabase, user.id, templateKey);
  if (!claimed.ok) return claimed.result;

  const columns: LogColumns = { category: copy.category, copy_key: copy.key };

  if (!rendered) {
    await outcomeWriter(supabase, now, user.id, templateKey, columns)({ status: 'skipped', reason: 'no_content' });
    return { status: 'skipped', reason: 'no_content' };
  }

  return deliverClaimed({
    supabase,
    now,
    user,
    template: templateKey,
    outgoing: {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: rendered.headers,
      tags: rendered.tags,
      rawHtml: true,
    },
    sender: deps.sendEmail ?? sendEmail,
    columns,
    sentEvent: copy.key === 'welcome_ads_connect' ? 'welcome_email_sent' : null,
  });
}
