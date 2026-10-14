import { appBaseUrl, buildOptOutUrl } from './opt-out';
import { firstName } from '@/lib/lifecycle/format';

export { firstName };

/**
 * Legacy registry for the #81 `send()` path. Every lifecycle mail now goes
 * through sendTemplate with lib/lifecycle/copy.ts; this keeps send() compiling.
 */
export type TemplateId = 'welcome_ads_connect';

export type RenderedEmail = {
  subject: string;
  html: string;
  footer: string;
  headers: Record<string, string>;
};

export type TemplateUser = { id: string; email: string; name?: string | null };

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/**
 * First mail after sign-up. The copy is Ayman's draft, kept in his words.
 * Returns null when no unsubscribe link can be signed: a mail without a
 * working opt-out must not go out.
 */
export function renderWelcomeAdsConnect(user: TemplateUser): RenderedEmail | null {
  const optOutUrl = buildOptOutUrl(user.id);
  if (!optOutUrl) return null;

  const name = firstName(user.name);
  const greeting = name ? `هلا ${escapeHtml(name)}` : 'هلا';
  const welcomeUrl = `${appBaseUrl()}/welcome`;

  const html =
    `<p style="margin:0 0 16px;font-size:18px">${greeting}</p>` +
    `<p style="margin:0 0 24px">سجلت في مُضاعِف وباقي خطوة وحدة تشوف بعدها قراءة حسابك الإعلاني: ربط الحساب</p>` +
    `<p style="margin:0 0 28px"><a href="${welcomeUrl}" style="display:inline-block;background:#0E1426;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:6px">اربط حسابك الإعلاني</a></p>` +
    `<p style="margin:0">لو علقت في أي خطوة رد على هذا الإيميل</p>`;

  return {
    subject: 'باقي خطوة وحدة على قراءة حسابك الإعلاني',
    html,
    footer: `ما تبي رسائل المتابعة؟ <a href="${optOutUrl}" style="color:#586174">أوقفها من هنا</a>`,
    headers: {
      'List-Unsubscribe': `<${optOutUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export type TemplateDefinition = {
  /** Funnel event written after a successful send, or null for none. */
  sentEvent: 'welcome_email_sent' | null;
  /**
   * When true, `send` refuses if ANY message was sent to this person in the
   * last 24 hours (one message per person per day). The welcome email does
   * not carry this flag, so it is never held back, but once it has gone out
   * it counts toward the limit for the follow-ups that come after it.
   */
  dailyLimit?: boolean;
  renderEmail: (user: TemplateUser) => RenderedEmail | null;
};

export const TEMPLATES: Record<TemplateId, TemplateDefinition> = {
  welcome_ads_connect: {
    sentEvent: 'welcome_email_sent',
    renderEmail: renderWelcomeAdsConnect,
  },
};
