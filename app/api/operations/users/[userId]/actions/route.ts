import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { isSameOriginRequest } from '@/lib/security/origin';
import { isModaafaOperator, isOperatorUser } from '@/lib/platform/operators';
import { readAccessOverrides } from '@/lib/billing/access-overrides';
import { extendStripeTrial } from '@/lib/billing/stripe';
import { createOperatorActionHandler } from '@/lib/platform/operator-actions';

export const dynamic = 'force-dynamic';

/**
 * POST /api/operations/users/:userId/actions
 * Body: { action, reason, confirm: true, days? | plan? | expiresAt? }
 * Operators only (isOperatorUser). Everything else answers 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const body = await req.json().catch(() => null);

  const handle = createOperatorActionHandler({
    isSameOrigin: () => isSameOriginRequest(req),
    getUser: async () => {
      const supabase = await createServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user ? { id: user.id, email: user.email ?? null, email_confirmed_at: user.email_confirmed_at ?? null } : null;
    },
    isOperator: (user) => isOperatorUser(user),
    rateLimit: async (operatorId) => {
      const result = await checkRateLimit({ req, scope: 'operator_action', limit: 30, windowSeconds: 600, identifier: operatorId });
      return { allowed: result.allowed };
    },
    loadTarget: async (id) => {
      const { data, error } = await createAdminClient().from('users').select('id, email').eq('id', id).maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, email: data.email ?? null } : null;
    },
    isOperatorEmail: (email) => isModaafaOperator(email),
    readOverrides: (id) => readAccessOverrides(createAdminClient(), id),
    findTrialingSubscription: async (id) => {
      const { data, error } = await createAdminClient()
        .from('subscriptions')
        .select('id, stripe_subscription_id, trial_ends_at')
        .eq('user_id', id)
        .eq('status', 'trialing')
        .not('stripe_subscription_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      return row?.stripe_subscription_id
        ? { id: row.id, stripeSubscriptionId: row.stripe_subscription_id, trialEndsAt: row.trial_ends_at ?? null }
        : null;
    },
    startAudit: async (row) => {
      const { data, error } = await createAdminClient()
        .from('operator_audit_log')
        .insert({
          operator_user_id: row.operatorUserId,
          operator_email: row.operatorEmail,
          action: row.action,
          target_user_id: row.targetUserId,
          reason: row.reason,
          details: row.details,
          status: 'started',
        })
        .select('id')
        .single();
      if (error || !data?.id) throw error ?? new Error('audit insert returned no id');
      return data.id as string;
    },
    finishAudit: async (auditId, outcome) => {
      const patch: Record<string, unknown> = { status: outcome.status, finished_at: new Date().toISOString() };
      if (outcome.details) patch.details = outcome.details;
      if (outcome.errorMessage) patch.error_message = outcome.errorMessage;
      const { error } = await createAdminClient().from('operator_audit_log').update(patch).eq('id', auditId);
      if (error) throw error;
    },
    extendStripeTrial,
    updateLocalTrialEnd: async (rowId, trialEndsAt) => {
      const { error } = await createAdminClient()
        .from('subscriptions')
        .update({ trial_ends_at: trialEndsAt })
        .eq('id', rowId);
      if (error) throw error;
    },
    revokeOverrides: async (id, kind) => {
      const { data, error } = await createAdminClient()
        .from('account_access_overrides')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', id)
        .eq('kind', kind)
        .is('revoked_at', null)
        .select('id');
      if (error) throw error;
      return data?.length ?? 0;
    },
    replacePlanGrant: async (row) => {
      const { error } = await createAdminClient().rpc('operator_replace_plan_grant', {
        p_user_id: row.userId,
        p_plan: row.plan,
        p_expires_at: row.expiresAt,
      });
      if (error) throw error;
    },
    insertOverride: async (row) => {
      const { error } = await createAdminClient().from('account_access_overrides').insert({
        user_id: row.userId,
        kind: row.kind,
        plan: row.plan,
        expires_at: row.expiresAt,
      });
      if (error) throw error;
    },
  });

  const result = await handle({ targetUserId: userId, body });
  return NextResponse.json(result.json, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
