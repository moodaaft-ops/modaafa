import { NextRequest, NextResponse } from 'next/server';
import { getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import {
  AUTOPILOT_POLICY_VERSION,
  autopilotExecutionGloballyEnabled,
} from '@/lib/autopilot/types';
import {
  normalizeAutopilotSettings,
  parseAutopilotSettingsInput,
  toAutopilotSettingsRow,
} from '@/lib/autopilot/settings';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';

const inputErrors: Record<string, string> = {
  invalid_mode: 'اختر وضعاً صحيحاً للطيار الآلي.',
  invalid_daily_limit: 'الحد اليومي يجب أن يكون بين 1 و3 تغييرات.',
  invalid_confidence: 'نسبة الثقة يجب أن تكون بين 95% و100%.',
  invalid_cooldown: 'فترة الانتظار يجب أن تكون بين 24 و168 ساعة.',
  confirmation_required: 'أكد فهمك لحدود التنفيذ المحافظ قبل تفعيله.',
};

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rateLimit = await checkRateLimit({
      req,
      scope: 'autopilot_settings',
      limit: 20,
      windowSeconds: 600,
      identifier: user.id,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'too_many_requests', message: 'انتظر قليلاً قبل تعديل الإعدادات مرة أخرى.' },
        { status: 429, headers: rateLimitHeaders(rateLimit) }
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'security_service_unavailable', message: 'تعذر التحقق من أمان الطلب حالياً.' },
      { status: 503 }
    );
  }

  const payload = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });

  const customerId = String(payload.customer_id ?? '').replace(/\D/g, '');
  if (!customerId) return NextResponse.json({ error: 'account_required' }, { status: 400 });

  const linked = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId,
    select: 'id, customer_id, customer_name, status, is_manager',
  });
  if (!linked.account) {
    return NextResponse.json({ error: linked.error ?? 'account_not_found' }, { status: 404 });
  }

  let input;
  try {
    input = parseAutopilotSettingsInput(payload);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'invalid_settings';
    return NextResponse.json(
      { error: code, message: inputErrors[code] ?? 'راجع إعدادات الطيار الآلي.' },
      { status: 400 }
    );
  }

  const [previousResult, access] = await Promise.all([
    supabase.from('autopilot_settings').select('*').eq('account_id', linked.account.id).maybeSingle(),
    getSubscriptionAccess(supabase, user.id, user.email),
  ]);
  if (previousResult.error) {
    console.error('Failed to read autopilot settings', previousResult.error);
    return NextResponse.json(
      { error: 'settings_unavailable', message: 'تعذر تحميل الإعدادات الحالية.' },
      { status: 503 }
    );
  }

  if (input.mode === 'conservative' && !access.active) {
    return NextResponse.json(
      {
        error: 'subscription_required',
        message: 'التنفيذ المحافظ يحتاج اشتراكاً نشطاً. يمكنك استخدام وضع المراقبة الآن.',
      },
      { status: 402 }
    );
  }

  const previous = normalizeAutopilotSettings(linked.account.id, previousResult.data);
  const nextRow = toAutopilotSettingsRow(linked.account.id, input, previous);

  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc('save_autopilot_settings', {
      p_account_id: linked.account.id,
      p_settings: nextRow,
      p_previous: previous,
      p_policy_version: AUTOPILOT_POLICY_VERSION,
    });
    if (error) throw error;
  } catch (error) {
    console.error('Failed to save autopilot settings', error);
    return NextResponse.json(
      { error: 'save_failed', message: 'تعذر حفظ إعدادات الطيار الآلي. لم يتغير وضع الحساب.' },
      { status: 500 }
    );
  }

  const settings = normalizeAutopilotSettings(linked.account.id, nextRow);
  return NextResponse.json({
    ok: true,
    settings,
    execution_globally_enabled: autopilotExecutionGloballyEnabled(),
  });
}
