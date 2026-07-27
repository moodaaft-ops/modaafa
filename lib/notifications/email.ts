import { isConfiguredEnv } from '@/lib/platform/env';

type EmailPayload = {
  to: string;
  subject: string;
  html: string;
};

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
    },
    body: JSON.stringify({
      from: from.trim(),
      to: [payload.to],
      subject: payload.subject,
      html: emailShell(payload.html),
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

export function subscriptionWelcomeEmail() {
  return {
    subject: 'تم تفعيل تجربة مُضاعِف',
    html: '<h2>أهلاً بك في مُضاعِف</h2><p>تم تفعيل تجربتك. يمكنك الآن استخدام المساعد الذكي وتشغيل الفحص ومراجعة التوصيات قبل أي تنفيذ.</p><p><a href="https://ai.modaafa.com/dashboard">الانتقال إلى لوحة التحكم</a></p>',
  };
}

/**
 * Sent three days before a trial converts into a real charge. Stripe emits
 * `customer.subscription.trial_will_end` for this; the handler for it was
 * missing entirely, so users were charged with no advance notice.
 */
export function trialEndingEmail(trialEndsAt?: string | null) {
  const endsOn = trialEndsAt
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date(trialEndsAt))
    : null;

  return {
    subject: 'تجربتك المجانية في مُضاعِف تنتهي قريباً',
    html: `<h2>تنتهي تجربتك المجانية قريباً</h2><p>${
      endsOn
        ? `تنتهي التجربة بتاريخ ${escapeHtml(endsOn)}، وبعدها يبدأ تجديد الاشتراك تلقائياً على الخطة المختارة.`
        : 'تنتهي التجربة خلال أيام، وبعدها يبدأ تجديد الاشتراك تلقائياً على الخطة المختارة.'
    }</p><p>إذا أردت تغيير الخطة أو إلغاء الاشتراك قبل التجديد، يمكنك ذلك في أي وقت من صفحة الفوترة.</p><p><a href="https://ai.modaafa.com/billing">إدارة الاشتراك</a></p>`,
  };
}

export function paymentFailedEmail() {
  return {
    subject: 'تعذر تجديد اشتراك مُضاعِف',
    html: '<h2>تعذر إتمام دفعة الاشتراك</h2><p>راجع وسيلة الدفع من صفحة الفوترة حتى لا تتوقف الخصائص المدفوعة.</p><p><a href="https://ai.modaafa.com/billing">إدارة الفوترة</a></p>',
  };
}

function emailShell(content: string) {
  return `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#0f172a;max-width:640px;margin:auto"><div style="padding:20px 0;font-size:22px;font-weight:700;color:#047857">مُضاعِف</div>${content}<hr style="border:0;border-top:1px solid #e2e8f0;margin:28px 0"><p style="font-size:12px;color:#64748b">هذه رسالة تشغيلية تخص حسابك في منصة مُضاعِف.</p></div>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
