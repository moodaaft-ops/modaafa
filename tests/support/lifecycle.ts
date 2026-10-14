import { EMAIL_COPY } from '../../lib/lifecycle/copy';
import type { SendTemplateFn, SendTemplateInput, SendTemplateResult } from '../../lib/lifecycle/run';
import type { PlanContext, PlanLogRow, PlanUser } from '../../lib/lifecycle/plan';
import type { CopyKey, EmailCopy } from '../../lib/lifecycle/types';
import type { createFakeAdmin } from './fake-admin';

/** Local Riyadh time to an instant: riyadh('2026-10-14T10:30'). */
export const riyadh = (local: string) => new Date(`${local}:00+03:00`);

export const ACTIVATED_AT = '2026-10-01T00:00:00+03:00';

/** The shipped stubs with every copy approved, so the planner has something to send. */
export function approvedCopy(): Record<CopyKey, EmailCopy> {
  return Object.fromEntries(
    Object.entries(EMAIL_COPY).map(([key, copy]) => [key, { ...copy, approved: true }])
  ) as Record<CopyKey, EmailCopy>;
}

export function makeUser(overrides: Partial<PlanUser> = {}): PlanUser {
  return {
    id: 'u1',
    email: 'u1@example.com',
    name: 'سلمان العتيبي',
    stage: 'registered',
    messagesOptOut: false,
    emailPrefs: null,
    emailSuppressedAt: null,
    ...overrides,
  };
}

export function makeCtx(args: {
  user?: Partial<PlanUser>;
  subscription?: Partial<NonNullable<PlanContext['subscription']>> | null;
  events?: PlanContext['events'];
  logs?: PlanLogRow[];
}): PlanContext {
  const subscription =
    args.subscription === null || args.subscription === undefined
      ? null
      : { status: 'trialing', createdAt: null, trialEndsAt: null, canceledAt: null, lastEventAt: null, currentPeriodStart: null, ...args.subscription };
  return {
    user: makeUser(args.user),
    subscription,
    events: args.events ?? {},
    logs: args.logs ?? [],
  };
}

export function sentLog(templateKey: string, sentAt: Date | string, category: string | null = 'lifecycle'): PlanLogRow {
  return {
    templateKey,
    status: 'sent',
    attempts: 1,
    sentAt: typeof sentAt === 'string' ? sentAt : sentAt.toISOString(),
    category,
  };
}

/**
 * Stand-in for agent B's sendTemplate. It does what matters to the runner:
 * claims the message_log row through the same claim_message rpc and stamps it
 * sent with the run's clock and the copy's category.
 */
export function fakeSendTemplate(admin: ReturnType<typeof createFakeAdmin>, options: { fail?: (input: SendTemplateInput) => SendTemplateResult | null } = {}) {
  const calls: SendTemplateInput[] = [];
  const fn: SendTemplateFn = async (input, deps) => {
    calls.push(input);
    const forced = options.fail?.(input);
    if (forced) return forced;
    const now = (deps as { now: () => Date }).now();
    const { data: claimed } = await admin.rpc('claim_message', {
      p_user_id: input.user.id,
      p_channel: 'email',
      p_template: input.templateKey,
    });
    if (!claimed) return { status: 'duplicate' };
    const row = admin.tables.message_log!.find(
      (r) => r.user_id === input.user.id && r.channel === 'email' && r.template === input.templateKey
    )!;
    Object.assign(row, {
      status: 'sent',
      sent_at: now.toISOString(),
      updated_at: now.toISOString(),
      category: input.copy.category,
      copy_key: input.copy.key,
      provider_id: `mail-${calls.length}`,
    });
    return { status: 'sent', providerId: `mail-${calls.length}` };
  };
  return { fn, calls };
}

/** Facts loader that gives every need a value, so the runner reaches sendTemplate. */
export const richFacts = async (_admin: unknown, user: { id: string; name: string | null }) => ({
  firstName: user.name?.split(' ')[0] ?? null,
  businessName: 'شركة',
  plan: { decisionsTotal: 9, lockedCount: 8, firstDecisionTitle: 'x', wasteEstimate: 1000, currency: 'SAR' },
  trial: { startedAt: '2026-10-01T00:00:00Z', endsAt: null, daysLeft: 5, approvedCount: 1, pendingCount: 2 },
  weekly: {
    periodStart: '2026-10-04',
    periodEnd: '2026-10-10',
    currency: 'SAR',
    spend: 1,
    conversions: 1,
    costPerConversion: 1,
    prevSpend: 1,
    prevConversions: 1,
    highlights: [],
    pendingCount: 0,
  },
  billing: { planName: 'growth', trialEndsAt: null },
});
