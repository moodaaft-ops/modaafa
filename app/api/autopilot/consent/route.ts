import { NextRequest, NextResponse } from 'next/server';
import { getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import { consentRecord, parseConsentInput } from '@/lib/autopilot/consent';
import { normalizeAutopilotSettings, toAutopilotSettingsRow } from '@/lib/autopilot/settings';
import { AUTOPILOT_POLICY_VERSION, autopilotExecutionGloballyEnabled } from '@/lib/autopilot/types';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { isChatFirstEnabled } from '@/lib/chat-first/flag';

/**
 * Stores the answer to the permission question from the chat card. It never
 * enables execution: mode stays as it is, except "always_ask" which turns an
 * account that is in conservative mode back off through the same audited RPC
 * as the settings page.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // The question is only ever asked inside the chat-first screen.
  if (!isChatFirstEnabled(process.env, user.email)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const rl = await checkRateLimit({ req, scope: 'autopilot_consent', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const input = parseConsentInput((await req.json().catch(() => null)) as Record<string, unknown> | null);
  if (!input) return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });

  const linked = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId: input.customerId,
    select: 'id, customer_id, status, is_manager',
  });
  if (!linked.account) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  const accountId = linked.account.id;

  const previousResult = await supabase.from('autopilot_settings').select('*').eq('account_id', accountId).maybeSingle();
  if (previousResult.error) return NextResponse.json({ error: 'settings_unavailable' }, { status: 503 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  if (input.answer === 'always_ask' && previousResult.data?.mode === 'conservative') {
    const previous = normalizeAutopilotSettings(accountId, previousResult.data);
    const nextRow = toAutopilotSettingsRow(
      accountId,
      {
        mode: 'off',
        max_daily_changes: previous.max_daily_changes,
        min_confidence: previous.min_confidence,
        cooldown_hours: previous.cooldown_hours,
        require_healthy_tracking: true,
        anomaly_pause_enabled: true,
        confirm_conservative: false,
      },
      previous
    );
    const { error } = await admin.rpc('save_autopilot_settings', {
      p_account_id: accountId,
      p_settings: nextRow,
      p_previous: previous,
      p_policy_version: AUTOPILOT_POLICY_VERSION,
    });
    if (error) {
      console.error('consent: failed to turn autopilot off', { code: error.code ?? null });
      return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    }
  }

  const { error } = await admin
    .from('autopilot_settings')
    .upsert(
      { account_id: accountId, consent: consentRecord(input.answer, input.channel), updated_at: new Date().toISOString() },
      { onConflict: 'account_id' }
    );
  if (error) {
    console.error('consent: save failed', { code: error.code ?? null });
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    answer: input.answer,
    execution_globally_enabled: autopilotExecutionGloballyEnabled(),
  });
}
