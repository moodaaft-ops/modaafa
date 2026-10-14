import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { isConfiguredEnv } from '@/lib/platform/env';
import { verifySvixSignature } from '@/lib/messaging/svix';
import { applyResendEvent, type ResendEvent } from '@/lib/messaging/webhook-events';

/**
 * Resend delivery events (delivered, opened, clicked, bounced, complained).
 *
 * Signed with Svix: the raw body is verified against RESEND_WEBHOOK_SECRET
 * before anything is parsed or written.
 *   503  no secret configured (nothing can be verified, Resend retries later)
 *   401  signature missing, wrong, or older than five minutes
 *   400  signed, but not JSON
 *   200  handled, ignored, or already applied (an unknown email id is 200)
 *   500  the database failed, so Resend retries the event
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!isConfiguredEnv(secret)) {
    return NextResponse.json({ error: 'webhook_secret_missing' }, { status: 503 });
  }

  const body = await req.text();
  const verified = verifySvixSignature({
    secret,
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
    body,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let event: ResendEvent;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    event = parsed as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    console.error('Resend webhook requires Supabase service role', error);
    return NextResponse.json({ error: 'service_role_missing' }, { status: 503 });
  }

  try {
    const outcome = await applyResendEvent(admin, event);
    return NextResponse.json({ received: true, ...outcome });
  } catch (error) {
    console.error('Resend webhook processing failed', { type: event.type, error });
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}
