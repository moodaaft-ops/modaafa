import { isEmailConfigured, sendEmail } from '@/lib/notifications/email';
import { appBaseUrl, buildLeadOptOutUrl } from '@/lib/messaging/opt-out';
import { LEAD_FOLLOWUP } from '@/config/lead-followup';
import { GROWTH_OWNER_CONFIG, hasSampleReportUrl, type GrowthOwnerConfig } from '@/lib/growth/owner-config';

export type RenderedLeadEmail = {
  subject: string;
  html: string;
  footer: string;
  headers: Record<string, string>;
};

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const button = (href: string, label: string) =>
  `<p style="margin:0 0 28px"><a href="${escapeHtml(href)}" style="display:inline-block;background:#0E1426;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:6px">${escapeHtml(label)}</a></p>`;

/**
 * Builds the email, or returns null when it must not go out: no sample report
 * link configured, or no key to sign the unsubscribe link with. A mail without
 * a working opt-out is never sent.
 */
export function renderLeadFollowup(
  lead: { id: string },
  options: { config?: GrowthOwnerConfig; followup?: typeof LEAD_FOLLOWUP } = {}
): RenderedLeadEmail | null {
  const config = options.config ?? GROWTH_OWNER_CONFIG;
  const copy = options.followup ?? LEAD_FOLLOWUP;
  if (!hasSampleReportUrl(config)) return null;
  const optOutUrl = buildLeadOptOutUrl(lead.id);
  if (!optOutUrl) return null;

  const html =
    `<p style="margin:0 0 16px">${escapeHtml(copy.intro)}</p>` +
    button(config.sampleReportUrl!.trim(), copy.reportLabel) +
    `<p style="margin:0 0 16px">${escapeHtml(copy.body)}</p>` +
    `<p style="margin:0 0 28px;color:#586174">${escapeHtml(copy.limit)}</p>` +
    `<p style="margin:0 0 16px">${escapeHtml(copy.startIntro)}</p>` +
    button(`${appBaseUrl()}/login`, copy.startLabel) +
    `<p style="margin:0">${escapeHtml(copy.reply)}</p>`;

  return {
    subject: copy.subject,
    html,
    footer: `ما تبي رسائل المتابعة؟ <a href="${optOutUrl}" style="color:#586174">أوقفها من هنا</a>`,
    headers: {
      'List-Unsubscribe': `<${optOutUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export type LeadRow = { id: string; channel: string; email: string | null };

export type LeadSendResult =
  | { status: 'sent' }
  | { status: 'not_approved' }
  | { status: 'not_configured' }
  | { status: 'skipped'; reason: string }
  | { status: 'duplicate' }
  | { status: 'failed'; reason: string };

export type LeadSendDeps = {
  supabase: any;
  sendEmail?: typeof sendEmail;
  emailConfigured?: () => boolean;
  approved?: boolean;
  config?: GrowthOwnerConfig;
  followup?: typeof LEAD_FOLLOWUP;
  now?: () => Date;
};

/**
 * Emails one lead the follow-up, at most once.
 *
 * The order matters: everything that can say "no" happens before the claim, so
 * a lead is never marked as attempted for a reason that had nothing to do with
 * them. The claim (claim_lead_followup) is one atomic UPDATE, so two requests
 * racing for the same lead cannot both send.
 */
export async function sendLeadFollowup(lead: LeadRow, deps: LeadSendDeps): Promise<LeadSendResult> {
  const approved = deps.approved ?? (deps.followup ?? LEAD_FOLLOWUP).approved;
  if (!approved) return { status: 'not_approved' };
  if (lead.channel !== 'email' || !lead.email) return { status: 'skipped', reason: 'not_email' };

  const emailConfigured = deps.emailConfigured ?? isEmailConfigured;
  if (!emailConfigured()) return { status: 'not_configured' };

  const rendered = renderLeadFollowup(lead, { config: deps.config, followup: deps.followup });
  if (!rendered) return { status: 'skipped', reason: 'sample_report_or_unsubscribe_secret_missing' };

  const { supabase } = deps;
  const now = (deps.now ?? (() => new Date()))().toISOString();

  // Someone who already signed up gets the sign-up emails, not a second pitch.
  const { data: existing, error: existingError } = await supabase
    .from('users')
    .select('id')
    .eq('email', lead.email)
    .limit(1)
    .maybeSingle();
  if (existingError) return { status: 'failed', reason: 'user_lookup_failed' };
  if (existing) {
    await supabase
      .from('visitor_leads')
      .update({ followup_status: 'skipped', followup_reason: 'already_user', followup_updated_at: now })
      .eq('id', lead.id);
    return { status: 'skipped', reason: 'already_user' };
  }

  const { data: claimed, error: claimError } = await supabase.rpc('claim_lead_followup', { p_lead_id: lead.id });
  if (claimError) return { status: 'failed', reason: `claim_failed: ${claimError.message}`.slice(0, 300) };
  if (!claimed) return { status: 'duplicate' };

  const finish = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from('visitor_leads')
      .update({ ...patch, followup_updated_at: now })
      .eq('id', lead.id);
    if (error) console.error('visitor_leads update failed', { leadId: lead.id, error });
  };

  try {
    const sender = deps.sendEmail ?? sendEmail;
    const result = await sender({
      to: lead.email,
      subject: rendered.subject,
      html: rendered.html,
      footer: rendered.footer,
      headers: rendered.headers,
      replyTo: process.env.WELCOME_REPLY_TO_EMAIL?.trim() || undefined,
      idempotencyKey: `lead-followup-${lead.id}`,
    });
    if (!result.sent) {
      const reason = ('reason' in result && result.reason) || 'not_sent';
      await finish({ followup_status: 'failed', followup_reason: reason });
      return { status: 'failed', reason };
    }
    await finish({
      followup_status: 'sent',
      followup_sent_at: now,
      followup_provider_id: result.id ?? null,
      followup_reason: null,
    });
    return { status: 'sent' };
  } catch (error) {
    // A code, never the provider's text: it can echo the address we tried.
    const reason = 'send_threw';
    await finish({ followup_status: 'failed', followup_reason: reason });
    return { status: 'failed', reason };
  }
}

export type LeadSweepSummary = {
  checked: number;
  sent: number;
  skipped: number;
  duplicate: number;
  failed: number;
  not_approved: number;
  not_configured: number;
};

const CATCH_UP_HOURS = 48;

/** Safe to call every minute and from several places at once. */
export async function sendDueLeadFollowups(
  supabase: any,
  options: { limit?: number; deps?: Omit<LeadSendDeps, 'supabase'>; now?: Date } = {}
): Promise<LeadSweepSummary> {
  const summary: LeadSweepSummary = { checked: 0, sent: 0, skipped: 0, duplicate: 0, failed: 0, not_approved: 0, not_configured: 0 };
  const approved = options.deps?.approved ?? (options.deps?.followup ?? LEAD_FOLLOWUP).approved;
  if (!approved) return { ...summary, not_approved: 1 };

  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - CATCH_UP_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('visitor_leads')
    .select('id, channel, email')
    .eq('channel', 'email')
    .eq('messages_opt_out', false)
    .in('followup_status', ['pending', 'failed', 'sending'])
    .lt('followup_attempts', 3)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(options.limit ?? 25);
  if (error) throw new Error(`lead sweep: lookup failed: ${error.message}`);

  for (const lead of (data ?? []) as LeadRow[]) {
    summary.checked += 1;
    const result = await sendLeadFollowup(lead, { ...options.deps, supabase });
    if (result.status === 'sent') summary.sent += 1;
    else if (result.status === 'skipped') summary.skipped += 1;
    else if (result.status === 'duplicate') summary.duplicate += 1;
    else if (result.status === 'not_approved') summary.not_approved += 1;
    else if (result.status === 'not_configured') summary.not_configured += 1;
    else summary.failed += 1;
  }
  return summary;
}
