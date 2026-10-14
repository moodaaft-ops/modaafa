import { after } from 'next/server';
import { EMAIL_LIFECYCLE_ACTIVATED_AT } from '@/config/email-journeys';
import { EMAIL_COPY } from '@/lib/lifecycle/copy';
import { defaultSendTemplate, type SendTemplateFn } from '@/lib/lifecycle/run';
import { EMPTY_FACTS, type EmailCopy } from '@/lib/lifecycle/types';
import { recordUserEvent } from '@/lib/stages/events';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * The welcome mail, sent the moment a registration completes (contract 0.1).
 *
 * Called fire-and-forget from lib/registration/service.ts right after
 * finalize_registration reports `completed`. It runs under the same switches as
 * the rest of the lifecycle (EMAIL_LIFECYCLE_ENABLED, an activation moment, an
 * approved copy), so until those are set it does nothing. The every-minute
 * /api/cron/welcome-email sweep stays as the safety net: both go through
 * message_log's unique (user, channel, template) row, so the person gets it once
 * whoever wins.
 *
 * It never throws and never blocks the registration.
 */
export type WelcomeOptions = {
  admin?: any;
  now?: Date;
  env?: Record<string, string | undefined>;
  /** An explicit null means "not activated". */
  activatedAt?: string | null;
  copy?: EmailCopy;
  sendTemplate?: SendTemplateFn;
  sendTemplateDeps?: object;
};

export async function sendWelcomeAfterRegistration(userId: string, options: WelcomeOptions = {}): Promise<string> {
  try {
    const env = options.env ?? process.env;
    if (env.EMAIL_LIFECYCLE_ENABLED !== 'true') return 'disabled';

    const now = options.now ?? new Date();
    const activatedAt = 'activatedAt' in options ? options.activatedAt ?? null : EMAIL_LIFECYCLE_ACTIVATED_AT;
    const activatedMs = activatedAt ? Date.parse(activatedAt) : Number.NaN;
    if (!Number.isFinite(activatedMs) || now.getTime() < activatedMs) return 'not_activated';

    const copy = options.copy ?? EMAIL_COPY.welcome_ads_connect;
    if (!copy.approved) return 'not_approved';

    const admin = options.admin ?? createAdminClient();
    const { data: user, error } = await admin
      .from('users')
      .select('id, email, name, messages_opt_out')
      .eq('id', userId)
      .maybeSingle();
    if (error || !user) return 'user_not_found';
    if (!user.email) return 'no_email';

    // The greeting is the only fact a brand-new account has: no business, plan or trial yet.
    const facts = { ...EMPTY_FACTS, firstName: firstNameOf(user.name) };
    const result = await (options.sendTemplate ?? defaultSendTemplate)(
      {
        user: { id: user.id, email: user.email, name: user.name, messages_opt_out: user.messages_opt_out === true },
        templateKey: copy.key,
        copy,
        facts,
        enforceGap: false,
      },
      { supabase: admin, now: () => now, ...options.sendTemplateDeps }
    );

    if (result.status === 'sent') {
      // Idempotent (unique once-per-user index); the funnel report reads this event.
      await recordUserEvent(userId, 'welcome_email_sent', { admin, occurredAt: now });
      return 'sent';
    }
    return 'reason' in result ? `${result.status}:${result.reason}` : result.status;
  } catch (error) {
    console.error('[welcome-email] immediate send failed', { message: error instanceof Error ? error.message : 'unknown' });
    return 'failed:exception';
  }
}

/** Runs after the response when inside a request (Next `after()`), otherwise right away. */
export function sendWelcomeInBackground(userId: string): void {
  const work = async () => {
    await sendWelcomeAfterRegistration(userId);
  };
  try {
    after(work);
  } catch {
    // Called outside a request scope (a script or a test): just start it.
    void work();
  }
}

function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 && first.length <= 40 ? first : null;
}
