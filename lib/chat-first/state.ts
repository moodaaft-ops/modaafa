import { getLinkedGoogleAdsAccount, normalizeCustomerId } from '@/lib/accounts/selection';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { getSubscriptionAccess } from '@/lib/billing/entitlements';
import { buildExecutableAction } from '@/lib/ai/executable-action';
import type { ChatRecommendation, ChatState } from './contracts';
import { readFreeAuditView } from './free-audit-view';

export type LoadedChatState =
  | { ok: true; state: ChatState; accountId: string | null }
  | { ok: false; error: 'account_not_found' | 'read_failed' };

/**
 * Reads everything through the caller's RLS client. When the caller names a
 * customer id, that account must be linked to THEIR business or the answer is
 * account_not_found, the same answer a nonexistent id gets, so ids of other
 * users' accounts cannot be probed.
 */
export async function loadChatState({
  supabase,
  userId,
  userEmail,
  requestedCustomerId,
  cookieCustomerId,
}: {
  supabase: any;
  userId: string;
  userEmail?: string | null;
  requestedCustomerId?: string | null;
  cookieCustomerId?: string | null;
}): Promise<LoadedChatState> {
  const explicit = normalizeCustomerId(requestedCustomerId ?? '');
  const customerId = explicit || normalizeCustomerId(cookieCustomerId ?? '');

  const [subscription, linked] = await Promise.all([
    getSubscriptionAccess(supabase, userId, userEmail),
    getLinkedGoogleAdsAccount({
      supabase,
      userId,
      customerId,
      select: 'id, customer_id, customer_name',
    }),
  ]);

  if (!linked.account) {
    // A named account that is not theirs is an error; a user with no account
    // at all (or a stale cookie) simply gets the "connect" state.
    if (explicit) return { ok: false, error: 'account_not_found' };
    if (customerId && linked.business) {
      const fallback = await getLinkedGoogleAdsAccount({
        supabase,
        userId,
        select: 'id, customer_id, customer_name',
      });
      if (fallback.account) return build(supabase, fallback.account, subscription.active);
    }
    return {
      ok: true,
      accountId: null,
      state: {
        accountLinked: false,
        accountName: null,
        customerId: null,
        latestAudit: null,
        recommendations: [],
        subscriptionActive: subscription.active,
      },
    };
  }
  return build(supabase, linked.account, subscription.active);
}

async function build(supabase: any, account: any, subscriptionActive: boolean): Promise<LoadedChatState> {
  const [auditRes, recRes] = await Promise.all([
    supabase
      .from('audits')
      .select('id, health_score, findings, estimated_monthly_waste, ran_at')
      .eq('account_id', account.id)
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('recommendations')
      .select('id, title, description, severity, status, action_payload')
      .eq('account_id', account.id)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  if (auditRes.error || recRes.error) return { ok: false, error: 'read_failed' };

  const audit = auditRes.data;
  // Subscribers use their plan allowance, so the free ledger is irrelevant to them.
  const freeAudit = subscriptionActive ? undefined : await readFreeAuditView(normalizeCustomerId(account.customer_id));
  const recommendations: ChatRecommendation[] = (recRes.data ?? []).map((r: any) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    severity: r.severity ?? null,
    status: r.status,
    executable: Boolean(buildExecutableAction(r.action_payload, r)),
  }));

  return {
    ok: true,
    accountId: account.id,
    state: {
      accountLinked: true,
      accountName: googleAdsAccountDisplayName(account),
      customerId: normalizeCustomerId(account.customer_id),
      latestAudit: audit
        ? {
            id: audit.id,
            healthScore: audit.health_score ?? null,
            findingsCount: Array.isArray(audit.findings) ? audit.findings.length : 0,
            estimatedMonthlyWaste:
              audit.estimated_monthly_waste == null ? null : Number(audit.estimated_monthly_waste),
            ranAt: audit.ran_at,
          }
        : null,
      recommendations,
      subscriptionActive,
      ...(freeAudit ? { freeAudit } : {}),
    },
  };
}
