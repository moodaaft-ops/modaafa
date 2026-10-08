import { createAdminClient } from '@/lib/supabase/server';
import {
  consumeFeatureUsage,
  getSubscriptionAccess,
  refundFeatureUsage,
} from '@/lib/billing/entitlements';

/**
 * Free audits per Google Ads account: the first full audit plus one retry.
 * The allowance belongs to the Google customer id (see
 * db/migrations/20261009_free_audit_quota.sql), so unlinking and relinking the
 * account or deleting its row never resets it.
 */
export const FREE_AUDITS_PER_ACCOUNT = 2;

export type AuditAccessFailure =
  | 'free_audits_exhausted'
  | 'audit_in_progress'
  | 'quota_exceeded'
  | 'subscription_required'
  | 'usage_storage_unavailable';

export type AuditAccess =
  | {
      ok: true;
      source: 'subscription';
      remaining: number;
      resetsAt: string;
      usageEventId: string;
    }
  | {
      ok: true;
      source: 'free';
      limit: number;
      used: number;
      remaining: number;
      freeEventId: string;
    }
  | { ok: false; reason: AuditAccessFailure; resetsAt?: string };

export function auditAccessStatus(reason?: string) {
  if (reason === 'free_audits_exhausted' || reason === 'subscription_required') return 402;
  if (reason === 'audit_in_progress') return 409;
  if (reason === 'quota_exceeded') return 429;
  return 503;
}

export function auditAccessMessage(reason?: string) {
  if (reason === 'free_audits_exhausted') {
    return 'استخدمت الفحصين المجانيين لهذا الحساب الإعلاني. تقاريرك وتوصياتك السابقة تبقى مفتوحة للقراءة، والاشتراك يلزم فقط لفحص جديد أو لتنفيذ التوصيات.';
  }
  if (reason === 'audit_in_progress') {
    return 'فيه فحص شغّال لهذا الحساب الآن. انتظر يخلص وبعدها تقدر تتابع.';
  }
  return null;
}

/** Read-only view of the allowance, for the UI and for tasks 02 and 05. */
export async function getFreeAuditStatus(customerId: string, admin: any = createAdminClient()) {
  const { count, error } = await admin
    .from('free_audit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId);
  if (error) return null;
  const used = Math.min(count ?? 0, FREE_AUDITS_PER_ACCOUNT);
  return { limit: FREE_AUDITS_PER_ACCOUNT, used, remaining: FREE_AUDITS_PER_ACCOUNT - used };
}

type Deps = {
  getSubscriptionAccess: typeof getSubscriptionAccess;
  consumeFeatureUsage: typeof consumeFeatureUsage;
};

const defaultDeps: Deps = { getSubscriptionAccess, consumeFeatureUsage };

/**
 * Decide whether this user may start an audit now and reserve what it costs.
 * Subscribers use their plan allowance; everyone else uses the free per-account
 * allowance. Reading and analysing never needs a subscription; applying
 * recommendations does and is gated separately.
 */
export async function reserveAuditAccess({
  supabase,
  userId,
  userEmail,
  accountId,
  customerId,
  deps = defaultDeps,
}: {
  supabase: any;
  userId: string;
  userEmail: string | null | undefined;
  accountId: string;
  customerId: string;
  deps?: Deps;
}): Promise<AuditAccess> {
  let subscription;
  try {
    subscription = await deps.getSubscriptionAccess(supabase, userId, userEmail);
  } catch (error) {
    console.error('Failed to read subscription for audit access', error);
    return { ok: false, reason: 'usage_storage_unavailable' };
  }

  if (subscription.active && subscription.plan) {
    const usage = await deps.consumeFeatureUsage({
      supabase,
      userId,
      userEmail,
      feature: 'audit',
      accountId,
      metadata: { customer_id: customerId },
    });
    if (!usage.ok) return { ok: false, reason: usage.reason, resetsAt: usage.resetsAt };
    return {
      ok: true,
      source: 'subscription',
      remaining: usage.remaining,
      resetsAt: usage.resetsAt,
      usageEventId: usage.usageEventId,
    };
  }

  const { data, error } = await supabase.rpc('consume_free_audit', {
    p_user_id: userId,
    p_customer_id: customerId,
    p_account_id: accountId,
    p_limit: FREE_AUDITS_PER_ACCOUNT,
    p_metadata: { source: 'audit_run' },
  });
  if (error) {
    console.error('Failed to reserve a free audit', error);
    return { ok: false, reason: 'usage_storage_unavailable' };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed || !row?.event_id) {
    return {
      ok: false,
      reason: row?.reason === 'audit_in_progress' ? 'audit_in_progress' : 'free_audits_exhausted',
    };
  }
  const used = Number(row.used ?? 1);
  return {
    ok: true,
    source: 'free',
    limit: FREE_AUDITS_PER_ACCOUNT,
    used,
    remaining: Math.max(0, FREE_AUDITS_PER_ACCOUNT - used),
    freeEventId: String(row.event_id),
  };
}

/** The audit finished: keep the reservation counted. */
export async function completeAuditAccess(supabase: any, userId: string, access: AuditAccess) {
  if (!access.ok || access.source !== 'free') return;
  const { error } = await supabase.rpc('complete_free_audit', {
    p_user_id: userId,
    p_event_id: access.freeEventId,
  });
  if (error) console.error('Failed to complete free audit reservation', error);
}

/** The audit failed on our side: give the allowance back. */
export async function releaseAuditAccess(userId: string, access: AuditAccess) {
  if (!access.ok) return false;
  if (access.source === 'subscription') {
    return refundFeatureUsage({ userId, usageEventId: access.usageEventId });
  }
  try {
    const { data, error } = await createAdminClient().rpc('refund_free_audit', {
      p_event_id: access.freeEventId,
    });
    if (error) {
      console.error('Failed to refund free audit', error);
      return false;
    }
    return data === true;
  } catch (error) {
    console.error('Failed to create the free audit refund client', error);
    return false;
  }
}
