import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { describeError } from '@/lib/supabase/query-errors';
import { hasValidCronAuthorization } from '@/lib/security/cron-auth';
import { partnersEnabled } from '@/lib/partners/config';
import { reconcilePartnerCommissions } from '@/lib/partners/store';

export const maxDuration = 60;

/**
 * Safety net behind the Stripe webhook: any paid invoice of a referred customer
 * that has no commission yet is earned now. Idempotent (the invoice key is
 * unique), so it can run any number of times. Does nothing unless PARTNERS_ENABLED=true.
 */
export async function GET(req: NextRequest) {
  if (!hasValidCronAuthorization(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!partnersEnabled()) return NextResponse.json({ skipped: 'disabled' });
  try {
    return NextResponse.json(await reconcilePartnerCommissions(createAdminClient()));
  } catch (error) {
    console.error('partner reconcile failed', error);
    return NextResponse.json({ error: 'reconcile_failed', message: describeError(error) }, { status: 500 });
  }
}
