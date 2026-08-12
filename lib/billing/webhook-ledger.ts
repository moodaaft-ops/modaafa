export type WebhookClaim = 'claimed' | 'already_completed' | 'in_flight';

/** Longer than the webhook route maxDuration, so a killed attempt is finished. */
export const DEFAULT_STALE_WEBHOOK_CLAIM_MS = 5 * 60 * 1000;

/**
 * Claim a Stripe event with an insert-first, primary-key-backed lock.
 *
 * `already_completed` is safe to acknowledge. `in_flight` must return a
 * non-2xx response so Stripe keeps retrying if the first worker disappears.
 */
export async function claimStripeWebhookEvent(
  supabase: any,
  eventId: string,
  eventType: string,
  options: { nowMs?: number; staleClaimMs?: number } = {},
): Promise<WebhookClaim> {
  const nowMs = options.nowMs ?? Date.now();
  const staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_WEBHOOK_CLAIM_MS;
  const now = new Date(nowMs).toISOString();

  const { error: insertError } = await supabase.from('processed_webhook_events').insert({
    event_id: eventId,
    event_type: eventType,
    status: 'processing',
    attempts: 1,
    last_attempt_at: now,
  });
  if (!insertError) return 'claimed';
  if ((insertError as { code?: string }).code !== '23505') throw insertError;

  const { data: existing, error: lookupError } = await supabase
    .from('processed_webhook_events')
    .select('status, attempts, last_attempt_at')
    .eq('event_id', eventId)
    .maybeSingle();
  throwOnSupabaseError('read duplicate Stripe event', lookupError);
  if (!existing) return 'in_flight';
  if (existing.status === 'completed') return 'already_completed';

  const lastAttemptAt = new Date(existing.last_attempt_at).getTime();
  const stale = !Number.isFinite(lastAttemptAt) || nowMs - lastAttemptAt > staleClaimMs;
  if (existing.status === 'processing' && !stale) return 'in_flight';

  const { data: claimed, error: claimError } = await supabase
    .from('processed_webhook_events')
    .update({
      status: 'processing',
      attempts: Number(existing.attempts ?? 1) + 1,
      last_attempt_at: now,
      error_message: null,
    })
    .eq('event_id', eventId)
    .eq('status', existing.status)
    .eq('last_attempt_at', String(existing.last_attempt_at))
    .select('event_id')
    .maybeSingle();
  throwOnSupabaseError('claim Stripe event retry', claimError);
  return claimed ? 'claimed' : 'in_flight';
}

export async function completeStripeWebhookEvent(
  supabase: any,
  eventId: string,
  completedAt = new Date().toISOString(),
) {
  const { data, error } = await supabase
    .from('processed_webhook_events')
    .update({ status: 'completed', completed_at: completedAt, error_message: null })
    .eq('event_id', eventId)
    .eq('status', 'processing')
    .select('event_id')
    .maybeSingle();
  throwOnSupabaseError('complete processed Stripe event', error);
  if (!data) throw new Error('Stripe event ledger claim was lost before completion');
}

export async function failStripeWebhookEvent(
  supabase: any,
  eventId: string,
  message: string,
  attemptedAt = new Date().toISOString(),
) {
  const { error } = await supabase
    .from('processed_webhook_events')
    .update({
      status: 'failed',
      error_message: message.slice(0, 1000),
      last_attempt_at: attemptedAt,
    })
    .eq('event_id', eventId);
  throwOnSupabaseError('mark Stripe event failed', error);
}

function throwOnSupabaseError(operation: string, error: unknown) {
  if (!error) return;
  throw new Error(`Failed to ${operation}`, { cause: error });
}
