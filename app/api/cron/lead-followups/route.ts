import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { sendDueLeadFollowups } from '@/lib/leads/followup';

export const maxDuration = 60;

/**
 * Catch-up for the exit-popup follow-up (db/proposals/20261014_lead_followup_cron.sql
 * calls it every few minutes). The visitor's own request already tries to send
 * immediately; this only picks up leads where that attempt could not run, for
 * example while the text was still waiting for Ayman's approval.
 * Idempotent: claim_lead_followup decides one winner per lead.
 */
export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    return NextResponse.json({ error: 'service_role_missing', message: describeError(error) }, { status: 503 });
  }

  try {
    return NextResponse.json(await sendDueLeadFollowups(supabase));
  } catch (error) {
    console.error('lead-followups sweep failed', error);
    return NextResponse.json({ error: 'sweep_failed', message: describeError(error) }, { status: 500 });
  }
}
