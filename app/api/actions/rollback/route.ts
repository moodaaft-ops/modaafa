import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/crypto';
import { getCustomer } from '@/lib/google-ads/client';
import { executeRollback } from '@/lib/ai/optimizer-agent';
import { consumeFeatureUsage, refundFeatureUsage } from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { safeLocalPath } from '@/lib/security/redirect';
import { sendOpsAlert } from '@/lib/notifications/email';
import { isSameOriginRequest } from '@/lib/security/origin';

const ROLLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {

  // Defence in depth against cross-site POSTs; see lib/security/origin.ts.
  if (!isSameOriginRequest(req)) {
    return NextResponse.redirect(new URL('/optimizer?error=invalid_origin', req.url), 303);
  }
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', req.url), 303);

  let mutationApplied = false;
  try {
    const rateLimit = await checkRateLimit({
      req,
      scope: 'action_rollback',
      limit: 10,
      windowSeconds: 3600,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rateLimit) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const form = await req.formData();
  const actionId = String(form.get('action_id') ?? '');
  const next = safeLocalPath(String(form.get('next') ?? '/optimizer'), '/optimizer');
  if (!actionId) return NextResponse.redirect(new URL(`${next}?error=invalid_rollback`, req.url), 303);

  const { data: action, error } = await supabase
    .from('ai_actions')
    .select('id, account_id, action_type, rollback_payload, rollback_status, reverted_at, created_at')
    .eq('id', actionId)
    .maybeSingle();
  if (error || !action) return NextResponse.redirect(new URL(`${next}?error=action_not_found`, req.url), 303);

  const rollback = action.rollback_payload as Record<string, any> | null;
  if (
    !rollback?.reversible ||
    action.reverted_at ||
    action.rollback_status === 'executing' ||
    Date.now() - new Date(action.created_at).getTime() > ROLLBACK_WINDOW_MS
  ) {
    return NextResponse.redirect(new URL(`${next}?error=rollback_unavailable`, req.url), 303);
  }

  const { data: account } = await supabase
    .from('google_ads_accounts')
    .select('id, customer_id, manager_id, refresh_token_encrypted')
    .eq('id', action.account_id)
    .eq('status', 'active')
    .maybeSingle();
  if (!account) return NextResponse.redirect(new URL(`${next}?error=account_not_found`, req.url), 303);

  const rollbackKey = randomUUID();
  const { data: claimed } = await supabase
    .from('ai_actions')
    .update({ rollback_status: 'executing', rollback_key: rollbackKey, rollback_started_at: new Date().toISOString() })
    .eq('id', action.id)
    .is('reverted_at', null)
    .or('rollback_status.is.null,rollback_status.neq.executing')
    .select('id')
    .maybeSingle();
  if (!claimed) return NextResponse.redirect(new URL(`${next}?error=rollback_unavailable`, req.url), 303);

  const usage = await consumeFeatureUsage({
    supabase,
    userId: user.id,
    feature: 'execute_action',
    accountId: account.id,
    metadata: { rollback_action_id: action.id, customer_id: account.customer_id },
  });
  if (!usage.ok) {
    await supabase.from('ai_actions').update({ rollback_status: null, rollback_key: null, rollback_started_at: null }).eq('id', action.id).eq('rollback_key', rollbackKey);
    return NextResponse.redirect(new URL(`${next}?error=${usage.reason}`, req.url), 303);
  }

  try {
    const customer = getCustomer(
      account.customer_id,
      decrypt(account.refresh_token_encrypted),
      account.manager_id ?? undefined
    );
    await executeRollback(rollback, customer, { validateOnly: true });
    const result = await executeRollback(rollback, customer);
    mutationApplied = true;
    const { data: recordedRollback, error: recordError } = await supabase
      .from('ai_actions')
      .update({
        rollback_status: 'reverted',
        rollback_result: { status: 'reverted', validate_only: 'passed', google_ads_result: result },
        reverted_at: new Date().toISOString(),
        reverted_by: user.id,
      })
      .eq('id', action.id)
      .eq('rollback_key', rollbackKey)
      .eq('rollback_status', 'executing')
      .select('id')
      .maybeSingle();
    if (recordError || !recordedRollback) {
      throw new Error(`Unable to persist completed rollback: ${recordError?.message ?? 'no row returned'}`);
    }
    return NextResponse.redirect(new URL(`${next}?reverted=1`, req.url), 303);
  } catch (rollbackError) {
    if (mutationApplied) {
      console.error('Google Ads rollback succeeded but rollback recording failed', {
        actionId: action.id,
        accountId: account.id,
        rollbackKey,
        error: operationalError(rollbackError),
      });
      await safeRollbackAlert({
        subject: 'تراجع Google Ads يحتاج مطابقة يدوية',
        message: 'نجح إرسال التراجع إلى Google Ads لكن تعذر تأكيد حفظ السجل. تُرك الإجراء مقفلاً لمنع تكرار التراجع.',
        details: {
          action_id: action.id,
          account_id: account.id,
          rollback_key: rollbackKey,
          action_type: action.action_type,
          error: operationalError(rollbackError),
        },
      });
      return NextResponse.redirect(new URL(`${next}?error=rollback_recording_failed`, req.url), 303);
    }

    await refundFeatureUsage({ supabase, userId: user.id, usageEventId: usage.usageEventId });
    await supabase
      .from('ai_actions')
      .update({
        rollback_status: 'failed',
        rollback_result: {
          status: 'failed',
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        },
      })
      .eq('id', action.id)
      .eq('rollback_key', rollbackKey);
    return NextResponse.redirect(new URL(`${next}?error=rollback_failed`, req.url), 303);
  }
}

async function safeRollbackAlert(payload: Parameters<typeof sendOpsAlert>[0]) {
  try {
    await sendOpsAlert(payload);
  } catch (error) {
    console.error('Failed to send rollback reconciliation alert', operationalError(error));
  }
}

function operationalError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 1000) }
    : { message: String(error).slice(0, 1000) };
}
