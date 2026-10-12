/**
 * Operator actions from the operations center (مركز التشغيل):
 *   extend_trial  move a trialing Stripe subscription's trial end forward
 *   grant_plan    give a free plan outside Stripe, optionally until a date
 *   revoke_plan   take that free plan back
 *   suspend       stop everything for an account (sync, optimizer, execution,
 *                 assistant, audits); billing is NOT touched
 *   unsuspend     lift it
 *
 * Every action needs an explicit confirm flag and a written reason, and is
 * recorded in operator_audit_log BEFORE anything changes. If that record
 * cannot be written the action does not run, so nothing happens unaudited.
 *
 * Written as a factory with injected dependencies so the authorization rules
 * can be tested without Supabase or Stripe (tests/operator-actions.test.ts).
 */

import type { LiveAccessOverrides, OverridePlan } from '@/lib/billing/access-overrides';

export const OPERATOR_ACTIONS = ['extend_trial', 'grant_plan', 'revoke_plan', 'suspend', 'unsuspend'] as const;
export type OperatorActionName = (typeof OPERATOR_ACTIONS)[number];

export const MAX_TRIAL_EXTENSION_DAYS = 60;
const MAX_GRANT_DAYS_AHEAD = 730;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OperatorActionInput =
  | { action: 'extend_trial'; reason: string; days: number }
  | { action: 'grant_plan'; reason: string; plan: OverridePlan; expiresAt: string | null }
  | { action: 'revoke_plan'; reason: string }
  | { action: 'suspend'; reason: string }
  | { action: 'unsuspend'; reason: string };

type ParseResult =
  | { ok: true; input: OperatorActionInput }
  | { ok: false; error: string; message: string };

function bad(error: string, message: string): ParseResult {
  return { ok: false, error, message };
}

/** Validate the request body. Pure. */
export function parseOperatorAction(body: unknown, now = Date.now()): ParseResult {
  if (!body || typeof body !== 'object') return bad('invalid_body', 'الطلب ناقص.');
  const raw = body as Record<string, unknown>;
  if (raw.confirm !== true) return bad('confirmation_required', 'لازم تأكيد الإجراء قبل تنفيذه.');

  const action = raw.action;
  if (typeof action !== 'string' || !(OPERATOR_ACTIONS as readonly string[]).includes(action)) {
    return bad('invalid_action', 'إجراء غير معروف.');
  }

  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 3) return bad('reason_required', 'اكتب سبب الإجراء (3 أحرف على الأقل).');
  if (reason.length > 500) return bad('reason_too_long', 'السبب أطول من 500 حرف.');

  if (action === 'extend_trial') {
    const days = Number(raw.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_TRIAL_EXTENSION_DAYS) {
      return bad('invalid_days', `عدد أيام التمديد من 1 إلى ${MAX_TRIAL_EXTENSION_DAYS}.`);
    }
    return { ok: true, input: { action, reason, days } };
  }

  if (action === 'grant_plan') {
    const plan = raw.plan;
    if (plan !== 'starter' && plan !== 'growth' && plan !== 'pro') {
      return bad('invalid_plan', 'اختر خطة: البداية أو النمو أو الاحتراف.');
    }
    let expiresAt: string | null = null;
    if (raw.expiresAt !== undefined && raw.expiresAt !== null && raw.expiresAt !== '') {
      if (typeof raw.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.expiresAt)) {
        return bad('invalid_expiry', 'تاريخ الانتهاء لازم يكون بصيغة يوم/شهر/سنة صحيحة.');
      }
      // End of that day in Riyadh (UTC+3), so "until 20 Oct" includes 20 Oct.
      const end = new Date(`${raw.expiresAt}T23:59:59+03:00`).getTime();
      if (!Number.isFinite(end)) return bad('invalid_expiry', 'تاريخ الانتهاء غير صحيح.');
      if (end <= now) return bad('expiry_in_past', 'تاريخ الانتهاء لازم يكون في المستقبل.');
      if (end > now + MAX_GRANT_DAYS_AHEAD * DAY_MS) {
        return bad('expiry_too_far', 'أقصى مدة للخطة المجانية سنتين، أو اتركها بدون تاريخ.');
      }
      expiresAt = new Date(end).toISOString();
    }
    return { ok: true, input: { action, reason, plan, expiresAt } };
  }

  return { ok: true, input: { action: action as 'revoke_plan' | 'suspend' | 'unsuspend', reason } };
}

/** New trial end: the extension counts from the later of today and the current end. */
export function computeExtendedTrialEnd(currentTrialEnd: string | null, days: number, now = Date.now()) {
  const current = currentTrialEnd ? new Date(currentTrialEnd).getTime() : NaN;
  const base = Number.isFinite(current) && current > now ? current : now;
  return new Date(base + days * DAY_MS);
}

export type OperatorUser = { id: string; email: string | null; email_confirmed_at?: string | null };

export type TrialingSubscription = {
  id: string;
  stripeSubscriptionId: string;
  trialEndsAt: string | null;
};

export type OperatorActionDeps = {
  isSameOrigin: () => boolean;
  getUser: () => Promise<OperatorUser | null>;
  isOperator: (user: OperatorUser) => boolean;
  /** Throws when the limiter itself is unavailable. */
  rateLimit: (operatorId: string) => Promise<{ allowed: boolean }>;
  loadTarget: (userId: string) => Promise<{ id: string; email: string | null } | null>;
  isOperatorEmail: (email: string | null) => boolean;
  readOverrides: (userId: string) => Promise<LiveAccessOverrides>;
  findTrialingSubscription: (userId: string) => Promise<TrialingSubscription | null>;
  /** Returns the audit row id. Throws when it cannot be written. */
  startAudit: (row: {
    operatorUserId: string;
    operatorEmail: string;
    action: OperatorActionName;
    targetUserId: string;
    reason: string;
    details: Record<string, unknown>;
  }) => Promise<string>;
  finishAudit: (
    auditId: string,
    outcome: { status: 'succeeded' | 'failed'; details?: Record<string, unknown>; errorMessage?: string }
  ) => Promise<void>;
  extendStripeTrial: (params: {
    subscriptionId: string;
    trialEndUnix: number;
    idempotencyKey: string;
  }) => Promise<{ status: string; trialEnd: string | null }>;
  updateLocalTrialEnd: (subscriptionRowId: string, trialEndsAt: string) => Promise<void>;
  /** Revoke every live row of this kind for the user. Returns how many. */
  revokeOverrides: (userId: string, kind: 'suspension' | 'plan_grant') => Promise<number>;
  /** Throws { code: '23505' } style errors on a duplicate live row. */
  insertOverride: (row: {
    userId: string;
    kind: 'suspension' | 'plan_grant';
    plan: OverridePlan | null;
    expiresAt: string | null;
  }) => Promise<void>;
  now?: () => number;
};

export type OperatorActionResponse = { status: number; json: Record<string, unknown> };

function reply(status: number, json: Record<string, unknown>): OperatorActionResponse {
  return { status, json };
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505');
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (error && typeof error === 'object' && 'message' in error) return String((error as any).message).slice(0, 500);
  return String(error).slice(0, 500);
}

export function createOperatorActionHandler(deps: OperatorActionDeps) {
  const now = deps.now ?? (() => Date.now());

  return async function handle({
    targetUserId,
    body,
  }: {
    targetUserId: string;
    body: unknown;
  }): Promise<OperatorActionResponse> {
    if (!deps.isSameOrigin()) return reply(403, { error: 'invalid_origin' });

    const user = await deps.getUser();
    if (!user) return reply(401, { error: 'unauthorized' });
    // Not an operator: answer exactly like a missing route, as the page does.
    if (!deps.isOperator(user) || !user.email) return reply(404, { error: 'not_found' });

    try {
      const limit = await deps.rateLimit(user.id);
      if (!limit.allowed) return reply(429, { error: 'too_many_requests', message: 'إجراءات كثيرة ورا بعض، انتظر شوي.' });
    } catch {
      return reply(503, { error: 'security_service_unavailable', message: 'تعذر التحقق من الحد الآن، جرّب بعد قليل.' });
    }

    if (!UUID.test(targetUserId)) return reply(400, { error: 'invalid_user', message: 'معرّف العميل غير صحيح.' });

    const parsed = parseOperatorAction(body, now());
    if (!parsed.ok) return reply(400, { error: parsed.error, message: parsed.message });
    const input = parsed.input;

    const target = await deps.loadTarget(targetUserId);
    if (!target) return reply(404, { error: 'user_not_found', message: 'ما لقينا هذا العميل.' });

    if (input.action === 'suspend' && (target.id === user.id || deps.isOperatorEmail(target.email))) {
      return reply(400, { error: 'cannot_suspend_operator', message: 'ما يصير توقف حساب مشغّل.' });
    }

    // Preconditions, checked before anything is written.
    let trialing: TrialingSubscription | null = null;
    let newTrialEnd: Date | null = null;
    const overrides = await deps.readOverrides(target.id);

    if (input.action === 'extend_trial') {
      trialing = await deps.findTrialingSubscription(target.id);
      if (!trialing) {
        return reply(409, {
          error: 'no_active_trial',
          message: 'هذا العميل ما عنده تجربة شغالة في Stripe. لو تبي تعطيه وقت مجاني استخدم الخطة المجانية.',
        });
      }
      newTrialEnd = computeExtendedTrialEnd(trialing.trialEndsAt, input.days, now());
    }
    if (input.action === 'revoke_plan' && !overrides.grant) {
      return reply(409, { error: 'no_active_grant', message: 'ما عنده خطة مجانية شغالة.' });
    }
    if (input.action === 'suspend' && overrides.suspended) {
      return reply(409, { error: 'already_suspended', message: 'الحساب موقوف أصلاً.' });
    }
    if (input.action === 'unsuspend' && !overrides.suspended) {
      return reply(409, { error: 'not_suspended', message: 'الحساب مو موقوف.' });
    }

    const plannedDetails: Record<string, unknown> =
      input.action === 'extend_trial'
        ? {
            days: input.days,
            stripe_subscription_id: trialing!.stripeSubscriptionId,
            previous_trial_end: trialing!.trialEndsAt,
            new_trial_end: newTrialEnd!.toISOString(),
          }
        : input.action === 'grant_plan'
          ? {
              plan: input.plan,
              expires_at: input.expiresAt,
              replaces: overrides.grant ? { plan: overrides.grant.plan, expires_at: overrides.grant.expiresAt } : null,
            }
          : input.action === 'revoke_plan'
            ? { plan: overrides.grant?.plan ?? null }
            : {};

    let auditId: string;
    try {
      auditId = await deps.startAudit({
        operatorUserId: user.id,
        operatorEmail: user.email,
        action: input.action,
        targetUserId: target.id,
        reason: input.reason,
        details: plannedDetails,
      });
    } catch (error) {
      console.error('Operator audit log unavailable; action refused', errorText(error));
      return reply(503, {
        error: 'audit_unavailable',
        message: 'ما قدرنا نسجل الإجراء في سجل التدقيق، فما نفذناه. غالباً ميقريشن مركز التشغيل ما انشغل بعد.',
      });
    }

    try {
      let result: Record<string, unknown> = {};

      if (input.action === 'extend_trial') {
        const stripeResult = await deps.extendStripeTrial({
          subscriptionId: trialing!.stripeSubscriptionId,
          trialEndUnix: Math.floor(newTrialEnd!.getTime() / 1000),
          idempotencyKey: `operator-extend-trial:${auditId}`,
        });
        const confirmedEnd = stripeResult.trialEnd ?? newTrialEnd!.toISOString();
        let localSynced = true;
        try {
          await deps.updateLocalTrialEnd(trialing!.id, confirmedEnd);
        } catch (error) {
          // Stripe is the source of truth and its webhook rewrites this row.
          localSynced = false;
          console.error('Trial extended in Stripe but the local row was not updated', errorText(error));
        }
        result = { trial_end: confirmedEnd, stripe_status: stripeResult.status, local_synced: localSynced };
      } else if (input.action === 'grant_plan') {
        await deps.revokeOverrides(target.id, 'plan_grant');
        await deps.insertOverride({ userId: target.id, kind: 'plan_grant', plan: input.plan, expiresAt: input.expiresAt });
        result = { plan: input.plan, expires_at: input.expiresAt };
      } else if (input.action === 'revoke_plan') {
        result = { revoked: await deps.revokeOverrides(target.id, 'plan_grant') };
      } else if (input.action === 'suspend') {
        await deps.insertOverride({ userId: target.id, kind: 'suspension', plan: null, expiresAt: null });
        result = { suspended: true };
      } else {
        result = { revoked: await deps.revokeOverrides(target.id, 'suspension') };
      }

      await deps.finishAudit(auditId, { status: 'succeeded', details: { ...plannedDetails, result } }).catch((error) =>
        console.error('Could not mark operator audit row succeeded', errorText(error))
      );
      return reply(200, { ok: true, action: input.action, result, audit_id: auditId });
    } catch (error) {
      const message = errorText(error);
      await deps
        .finishAudit(auditId, { status: 'failed', errorMessage: message })
        .catch((finishError) => console.error('Could not mark operator audit row failed', errorText(finishError)));

      if (isUniqueViolation(error)) {
        return reply(409, { error: 'conflict', message: 'فيه إجراء ثاني على نفس العميل صار بنفس اللحظة. حدّث الصفحة وشوف.' });
      }
      if (input.action === 'extend_trial') {
        return reply(502, { error: 'stripe_failed', message: `Stripe رفض التمديد: ${message}` });
      }
      return reply(500, { error: 'action_failed', message: 'صار خطأ وما تم الإجراء. انكتب في سجل التدقيق.' });
    }
  };
}
