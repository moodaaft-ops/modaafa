import { createAdminClient } from '@/lib/supabase/server';
import type { UserEventType } from '@/lib/stages/types';

/**
 * Records one of the shared user events and, for the three stage-moving
 * events, advances users.stage. Both happen inside the database function
 * `record_user_event`, which only ever inserts the first occurrence and only
 * ever moves the stage forward, so calling this twice, late, or out of order
 * is harmless.
 *
 * It NEVER throws. A tracking failure must not break a connect job, a page
 * render or a Stripe webhook; it is logged and reported through the return
 * value instead. That also covers the window before the migration has been
 * run by hand: the function does not exist yet and the call just logs.
 *
 * Returns true when this call was the first time the event was seen.
 */
export async function recordUserEvent(
  userId: string,
  event: UserEventType,
  options: { occurredAt?: Date; metadata?: Record<string, unknown>; admin?: any } = {}
): Promise<boolean> {
  try {
    const admin = options.admin ?? createAdminClient();
    const { data, error } = await admin.rpc('record_user_event', {
      p_user_id: userId,
      p_event: event,
      p_occurred_at: (options.occurredAt ?? new Date()).toISOString(),
      p_metadata: options.metadata ?? {},
    });
    if (error) {
      console.error('[user-events] could not record event', { event, code: error.code });
      return false;
    }
    return data === true;
  } catch (error) {
    console.error('[user-events] could not record event', {
      event,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}
