/**
 * What the chat says when its route stops answering because the person lost
 * access while the screen was open (the trial ended, a payment failed, an
 * operator suspended the account). The route answers 402 `subscription_required`
 * or 403 `account_suspended`; the screen used to read both as «صار خلل عندنا»
 * and offer a retry that could never work.
 *
 * Pure and client-safe (no server imports) so a test pins the wording and the
 * decision. The code in the body decides, never the status alone: a 403 is also
 * `invalid_origin` and `ticket_invalid`, which are not about access.
 */

export type ChatAccessLoss = {
  code: 'subscription_required' | 'account_suspended';
  /** The assistant's message in the thread. */
  message: string;
  /** The one way forward, or null when there is none to give (a suspension). */
  cta: { label: string; href: string } | null;
};

/** Where the person goes to fix a stopped plan: /billing handles a first subscription, a failed payment and a paused plan. */
export const ACCESS_LOSS_BILLING_HREF = '/billing';

export const ACCESS_LOSS_COPY = {
  subscriptionRequired: 'اشتراكك واقف. فعّله أو حدّث بطاقتك عشان تكمل المحادثة.',
  subscriptionCta: 'فعّل اشتراكك',
  /** Same text as ACCOUNT_SUSPENDED_MESSAGE (pinned by a test); the route's own message wins when it sends one. */
  suspended: 'حسابك موقوف مؤقتاً، ولن تُنفذ أي عملية عليه حتى يُعاد تفعيله. تواصل معنا على واتساب 0554235720.',
} as const;

export function chatAccessLoss(status: number, body: unknown): ChatAccessLoss | null {
  const data = body && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : {};
  if (status === 402 && data.error === 'subscription_required') {
    return {
      code: 'subscription_required',
      message: ACCESS_LOSS_COPY.subscriptionRequired,
      cta: { label: ACCESS_LOSS_COPY.subscriptionCta, href: ACCESS_LOSS_BILLING_HREF },
    };
  }
  if (status === 403 && data.error === 'account_suspended') {
    const sent = typeof data.message === 'string' ? data.message.trim() : '';
    return { code: 'account_suspended', message: sent || ACCESS_LOSS_COPY.suspended, cta: null };
  }
  return null;
}
