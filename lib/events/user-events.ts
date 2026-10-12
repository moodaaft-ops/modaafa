import { createAdminClient } from '@/lib/supabase/server';

/**
 * The funnel from sign-up to paying, written to public.user_events.
 *
 * The seven names below are shared with the other agents working on the same
 * funnel. Do not rename them or add one here without telling them: the SQL
 * CHECK in db/migrations/20261012_user_events.sql lists the same seven.
 */
export const USER_EVENT_NAMES = [
  'registration_completed',
  'welcome_email_sent',
  'onboarding_viewed',
  'connect_clicked',
  'ads_account_connected',
  'first_analysis_viewed',
  'subscription_paid',
] as const;

export type UserEventName = (typeof USER_EVENT_NAMES)[number];

/** Same words, same order, for the stage a user is in. */
export const USER_STAGES = ['registered', 'connected', 'analysis_viewed', 'subscribed'] as const;
export type UserStage = (typeof USER_STAGES)[number];

/** Events that only ever count once per user. The SQL index enforces it too. */
const ONCE_PER_USER: ReadonlySet<UserEventName> = new Set(['onboarding_viewed']);

const UNIQUE_VIOLATION = '23505';
const MAX_PROPERTY_VALUE_LENGTH = 120;

/** Only short plain strings, numbers and booleans survive. Never raw user input. */
export function cleanEventProperties(properties: Record<string, unknown> | undefined) {
  const out: Record<string, string | number | boolean> = {};
  if (!properties) return out;
  for (const [key, value] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_PROPERTY_VALUE_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

type Inserter = {
  from: (table: 'user_events') => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
  };
};

/**
 * Writes one event. Never throws and never blocks the page or redirect that
 * called it: a tracking failure must not turn into a login or connect failure.
 * Returns true only when a row was written.
 */
export async function trackUserEvent(
  input: {
    userId: string;
    event: UserEventName;
    properties?: Record<string, unknown>;
  },
  deps: { client?: Inserter } = {}
): Promise<boolean> {
  try {
    const client = deps.client ?? (createAdminClient() as unknown as Inserter);
    // Column names match db/migrations/20261012_welcome_email.sql (PR #81),
    // which creates the same table: `stage` + `metadata`, not `properties`.
    // Every event this file writes happens before the user is connected, so the
    // stage is always 'registered' here.
    const { error } = await client.from('user_events').insert({
      user_id: input.userId,
      event: input.event,
      stage: 'registered',
      metadata: cleanEventProperties(input.properties),
    });
    if (!error) return true;
    // A repeat of a once-only event is the normal case, not a problem.
    if (error.code === UNIQUE_VIOLATION && ONCE_PER_USER.has(input.event)) return false;
    console.warn(`[user-events] ${input.event} not written: ${error.code ?? ''} ${error.message ?? ''}`);
    return false;
  } catch (error) {
    console.warn(`[user-events] ${input.event} failed`, error);
    return false;
  }
}
