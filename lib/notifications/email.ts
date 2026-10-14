import { isConfiguredEnv } from '@/lib/platform/env';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import { EMPTY_FACTS, type BillingFacts, type CopyKey, type RenderedMessage } from '@/lib/lifecycle/types';
import { firstName } from '@/lib/lifecycle/format';
import { renderTemplate } from '@/lib/messaging/render';

export type EmailTag = { name: string; value: string };

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Mail clients and spam filters like a message that has one. */
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Resend de-duplicates two calls carrying the same key for 24 hours. */
  idempotencyKey?: string;
  /** Skip the operational footer when the caller supplies its own. */
  footer?: string;
  /** Resend tags (shown in the dashboard and echoed back by webhooks). Names and values are cleaned to ASCII. */
  tags?: EmailTag[];
  /**
   * `html` is already a complete document in the brand shell (lib/messaging/render.ts):
   * send it exactly as given, without the old operational wrapper.
   */
  rawHtml?: boolean;
};

/** Resend allows only ASCII letters, digits, underscore and dash in tag names and values. */
function cleanTag(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'unknown';
}

export function isEmailConfigured() {
  return isConfiguredEnv(process.env.RESEND_API_KEY) && isConfiguredEnv(process.env.RESEND_FROM_EMAIL);
}

export async function sendEmail(payload: EmailPayload) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!isConfiguredEnv(apiKey) || !isConfiguredEnv(from)) {
    console.warn('Email skipped because RESEND_API_KEY or RESEND_FROM_EMAIL is missing');
    return { sent: false, reason: 'email_not_configured' as const };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
      ...(payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: from.trim(),
      to: [payload.to],
      subject: payload.subject,
      html: payload.rawHtml ? payload.html : emailShell(payload.html, payload.footer),
      ...(payload.text ? { text: payload.text } : {}),
      ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
      ...(payload.headers && Object.keys(payload.headers).length > 0 ? { headers: payload.headers } : {}),
      ...(payload.tags && payload.tags.length > 0
        ? { tags: payload.tags.map((tag) => ({ name: cleanTag(tag.name), value: cleanTag(tag.value) })) }
        : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json().catch(() => ({}));
  return { sent: true, id: data.id as string | undefined };
}

export async function sendOpsAlert({
  subject,
  message,
  details,
}: {
  subject: string;
  message: string;
  details?: unknown;
}) {
  const to = process.env.OPS_ALERT_EMAIL;
  if (!isConfiguredEnv(to)) {
    console.error('Operational alert', { subject, message, details });
    return { sent: false, reason: 'ops_email_missing' as const };
  }

  return sendEmail({
    to: to.trim(),
    subject: `[Modaafa] ${subject}`,
    html: `<h2>${escapeHtml(subject)}</h2><p>${escapeHtml(message)}</p>${
      details
        ? `<pre style="direction:ltr;text-align:left;white-space:pre-wrap">${escapeHtml(
            JSON.stringify(details, null, 2).slice(0, 8000)
          )}</pre>`
        : ''
    }`,
  });
}

/** The person a transactional mail is for. Read by the Stripe webhook before it sends. */
export type TransactionalRecipient = { id: string; email: string; name?: string | null };

/** Subject, html and text, ready for `sendEmail({ to, ...mail, rawHtml: true })`. */
export type TransactionalMail = Pick<RenderedMessage, 'subject' | 'html' | 'text' | 'headers' | 'tags'> & {
  rawHtml: true;
};

function renderTransactional(
  key: CopyKey,
  recipient: TransactionalRecipient,
  billing: BillingFacts | null
): TransactionalMail | null {
  const rendered = renderTemplate({
    copy: EMAIL_COPY[key],
    templateKey: key,
    user: recipient,
    facts: { ...EMPTY_FACTS, firstName: firstName(recipient.name) || null, billing },
  });
  if (!rendered) return null;
  const { subject, html, text, headers, tags } = rendered;
  return { subject, html, text, headers, tags, rawHtml: true };
}

/**
 * The three billing mails go through the same brand shell as the lifecycle
 * mail, with the copies tx_subscription_welcome, tx_trial_ending and
 * tx_payment_failed from lib/lifecycle/copy.ts. They are transactional: no
 * stop link, and the approved flag of the copy does not gate them.
 */
export function subscriptionWelcomeEmail(recipient: TransactionalRecipient) {
  return renderTransactional('tx_subscription_welcome', recipient, null);
}

/**
 * Sent three days before a trial converts into a real charge. Stripe emits
 * `customer.subscription.trial_will_end` for this; the handler for it was
 * missing entirely, so users were charged with no advance notice.
 */
export function trialEndingEmail(trialEndsAt: string | null | undefined, recipient: TransactionalRecipient) {
  return renderTransactional('tx_trial_ending', recipient, { planName: null, trialEndsAt: trialEndsAt ?? null });
}

export function paymentFailedEmail(recipient: TransactionalRecipient) {
  return renderTransactional('tx_payment_failed', recipient, null);
}

function emailShell(content: string, footer = 'هذه رسالة تشغيلية تخص حسابك في منصة مُضاعِف.') {
  return `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#0E1426;max-width:640px;margin:auto"><div style="padding:20px 0;font-size:22px;font-weight:700;color:#0E1426">مُضاعِف</div>${content}<hr style="border:0;border-top:1px solid #CDCFD4;margin:28px 0"><p style="font-size:12px;color:#586174">${footer}</p></div>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
