import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getLinkedGoogleAdsAccount, getUserBusinessWithClient } from '@/lib/accounts/selection';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isSimpleExperience } from '@/lib/setup/mode';
import { isAdaptiveKey, parseAnswer, type SetupAnswer } from '@/lib/setup/questions';
import { saveSetupAnswer } from '@/lib/setup/save';
import { withProductTitles } from '@/lib/setup/adaptive/bank';
import { ensureSetupBusiness } from '@/lib/setup/adaptive/ensure-business';
import { isAdaptiveOnboarding } from '@/lib/setup/adaptive/flag';
import { loadStoredSignals } from '@/lib/setup/adaptive/signals-store';
import {
  ANSWER_KEYS_NEEDING_LEDGER,
  ANSWER_KEYS_NEEDING_SIGNALS,
  reactionContextFor,
} from '@/lib/setup/adaptive/view';
import { readLedgerEntries } from '@/lib/setup/load';
import type { AdaptiveAnswer } from '@/lib/setup/adaptive/types';
import type { AdaptiveReactionContext } from '@/lib/setup/adaptive/answers';

export const dynamic = 'force-dynamic';

const isAdaptiveAnswer = (answer: SetupAnswer): answer is AdaptiveAnswer => isAdaptiveKey(answer.key);

/**
 * One answer from the setup chat. The key and the value are both checked
 * against the same rules the screen uses (lib/setup/questions.ts); nothing the
 * browser sends is written as-is except the few free-text fields, which are
 * cleaned and capped there.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isSimpleExperience(process.env, user.email)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const rl = await checkRateLimit({ req, scope: 'setup_answer', limit: 80, windowSeconds: 600, identifier: user.id });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }
  } catch {
    return NextResponse.json({ error: 'security_service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  // The adaptive keys exist only for someone the tree is switched on for; for anyone else they are not here.
  const adaptiveOn = isAdaptiveOnboarding(process.env, user.email);
  if (isAdaptiveKey(body?.key) && !adaptiveOn) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const parsed = parseAnswer(body?.key, body?.answer);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let business: { id: string; selected_google_ads_customer_id?: string | null } | null = await getUserBusinessWithClient(supabase, user.id).catch(() => null);
  // «ما عندي حساب إعلانات» comes before any Google link, so the workspace does not exist yet.
  if (!business && adaptiveOn && parsed.answer.key === 'has_account') {
    business = await ensureSetupBusiness(supabase, user);
  }
  if (!business) return NextResponse.json({ error: 'no_business' }, { status: 409 });

  const linked = await getLinkedGoogleAdsAccount({
    supabase,
    userId: user.id,
    customerId: business.selected_google_ads_customer_id ?? '',
    select: 'id',
  }).catch(() => null);

  let admin: any = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  // What only the server knows: the stored read of the linked account (picked product titles, the average
  // order) and earlier answers (the deal value). Read only for the few answers that use them.
  let answer: SetupAnswer = parsed.answer;
  let reactionContext: AdaptiveReactionContext | undefined;
  if (adaptiveOn && admin && isAdaptiveAnswer(answer) && ANSWER_KEYS_NEEDING_SIGNALS.includes(answer.key)) {
    const accountId = linked?.account?.id ?? null;
    const signals = accountId ? await loadStoredSignals(admin, accountId) : null;
    if (answer.key === 'push_products') answer = withProductTitles(answer, signals);
    const ledger = ANSWER_KEYS_NEEDING_LEDGER.includes(answer.key)
      ? (await readLedgerEntries(admin, business.id)).choices
      : new Map<string, string | null>();
    reactionContext = reactionContextFor({ answer, ledger, signals });
  }

  const outcome = await saveSetupAnswer({
    supabase,
    admin,
    userId: user.id,
    businessId: business.id,
    accountId: linked?.account?.id ?? null,
    answer,
    reactionContext,
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 500 });
  return NextResponse.json(outcome);
}
