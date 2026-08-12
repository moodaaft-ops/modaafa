export type SubscriptionEventWriteResult = 'inserted' | 'updated' | 'stale_or_missing';

export class LiveSubscriptionConflictError extends Error {
  readonly userId: string;
  readonly incomingSubscriptionId: string;

  constructor(userId: string, incomingSubscriptionId: string) {
    super('A different live Stripe subscription already exists for this user');
    this.name = 'LiveSubscriptionConflictError';
    this.userId = userId;
    this.incomingSubscriptionId = incomingSubscriptionId;
  }
}

type SubscriptionEventRow = Record<string, unknown> & {
  stripe_subscription_id: string;
  last_event_at: string;
};

/**
 * Apply a Stripe subscription snapshot only when its event is newer than the
 * snapshot already stored locally.
 *
 * The update-first/insert/retry sequence is race-safe:
 * - existing rows are updated with a database-side timestamp guard;
 * - concurrent first events contend on the unique Stripe subscription id;
 * - the loser retries the guarded update instead of overwriting blindly.
 */
export async function applySubscriptionEvent(
  supabase: any,
  row: SubscriptionEventRow,
): Promise<SubscriptionEventWriteResult> {
  const subscriptionId = row.stripe_subscription_id.trim();
  const eventCreatedAt = row.last_event_at.trim();
  if (!subscriptionId || !eventCreatedAt || Number.isNaN(new Date(eventCreatedAt).getTime())) {
    throw new Error('Invalid Stripe subscription event identity');
  }

  const normalizedRow: SubscriptionEventRow = {
    ...row,
    stripe_subscription_id: subscriptionId,
    last_event_at: eventCreatedAt,
  };

  if (await updateExistingSubscription(supabase, normalizedRow)) return 'updated';

  // Events created by Modaafa carry userId in Stripe metadata. An older
  // subscription without it may update an existing row, but cannot create a
  // valid local row because subscriptions.user_id is required.
  if (!normalizedRow.user_id) return 'stale_or_missing';

  const { error: insertError } = await supabase.from('subscriptions').insert(normalizedRow);
  if (!insertError) return 'inserted';
  if ((insertError as { code?: string }).code !== '23505') {
    throw new Error('Failed to insert Stripe subscription event', { cause: insertError });
  }

  // Another delivery may have inserted this same Stripe subscription after
  // our first update. Re-run the guarded update so the newer event wins.
  if (await updateExistingSubscription(supabase, normalizedRow)) return 'updated';

  // `23505` can also come from subscriptions_one_live_per_user when two
  // different Checkout sessions complete concurrently. That is not a stale
  // event and must never be swallowed: Stripe may now be charging for a
  // subscription that has no local row. Distinguish the two constraints by
  // checking whether this Stripe subscription id exists after contention.
  const existing = await findSubscriptionByStripeId(supabase, subscriptionId);
  if (existing) return 'stale_or_missing';

  throw new LiveSubscriptionConflictError(String(normalizedRow.user_id), subscriptionId);
}

async function updateExistingSubscription(
  supabase: any,
  row: SubscriptionEventRow,
) {
  const { data, error } = await supabase
    .from('subscriptions')
    .update(row)
    .eq('stripe_subscription_id', row.stripe_subscription_id)
    .or(`last_event_at.is.null,last_event_at.lt.${row.last_event_at}`)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error('Failed to update Stripe subscription event', { cause: error });
  }
  return Boolean(data);
}

async function findSubscriptionByStripeId(supabase: any, subscriptionId: string) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) {
    throw new Error('Failed to classify Stripe subscription conflict', { cause: error });
  }
  return data ?? null;
}
