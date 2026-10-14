import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { sendDueWelcomeEmails } from '@/lib/messaging/welcome';

export const maxDuration = 60;

/**
 * Safety net for the welcome mail that normally goes out right after sign-up.
 * Meant to be called every minute (proposal: db/proposals/20261012_welcome_email_cron.sql,
 * not part of the migrations folder; nothing is scheduled by default).
 *
 * Does nothing (no reads, no writes) unless EMAIL_LIFECYCLE_ENABLED=true and
 * EMAIL_LIFECYCLE_ACTIVATED_AT has passed, and only looks at registrations from
 * the activation moment on. Idempotent: message_log's unique row means a repeat
 * call never mails twice.
 */
export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  try {
    const summary = await sendDueWelcomeEmails(supabase);
    return NextResponse.json(summary);
  } catch (error) {
    console.error('welcome-email sweep failed', error);
    return NextResponse.json({ error: 'sweep_failed', message: describeError(error) }, { status: 500 });
  }
}
