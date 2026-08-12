import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySubscriptionEvent,
  LiveSubscriptionConflictError,
} from '../lib/billing/subscription-events';

type StoredRow = Record<string, unknown> & {
  id: string;
  stripe_subscription_id: string;
  last_event_at: string | null;
};

class FakeSubscriptions {
  rows = new Map<string, StoredRow>();
  concurrentInsert: StoredRow | null = null;
  conflictingLiveUser = false;
  deletedUserForeignKey = false;
  userExists = true;

  from(table: string) {
    if (table === 'subscriptions') return new FakeQuery(this);
    if (table === 'users') return new FakeUsersQuery(this);
    throw new Error(`Unexpected table ${table}`);
  }
}

class FakeQuery {
  private operation: 'read' | 'update' | null = null;
  private payload: Record<string, unknown> = {};
  private subscriptionId: string | null = null;
  private eventCreatedAt: string | null = null;

  constructor(private readonly database: FakeSubscriptions) {}

  update(payload: Record<string, unknown>) {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  async insert(payload: Record<string, unknown>) {
    const subscriptionId = String(payload.stripe_subscription_id);
    if (this.database.deletedUserForeignKey) return { error: { code: '23503' } };
    if (this.database.conflictingLiveUser) return { error: { code: '23505' } };
    if (this.database.concurrentInsert) {
      this.database.rows.set(subscriptionId, this.database.concurrentInsert);
      this.database.concurrentInsert = null;
      return { error: { code: '23505' } };
    }
    if (this.database.rows.has(subscriptionId)) return { error: { code: '23505' } };

    this.database.rows.set(subscriptionId, {
      id: `local-${subscriptionId}`,
      ...payload,
      stripe_subscription_id: subscriptionId,
      last_event_at: String(payload.last_event_at),
    });
    return { error: null };
  }

  eq(column: string, value: string) {
    assert.equal(column, 'stripe_subscription_id');
    this.subscriptionId = value;
    return this;
  }

  or(filter: string) {
    const marker = 'last_event_at.lt.';
    const index = filter.indexOf(marker);
    assert.ok(index >= 0);
    this.eventCreatedAt = filter.slice(index + marker.length);
    return this;
  }

  select(column: string) {
    assert.equal(column, 'id');
    if (!this.operation) this.operation = 'read';
    return this;
  }

  async maybeSingle() {
    assert.ok(this.subscriptionId);

    const existing = this.database.rows.get(this.subscriptionId);
    if (!existing) return { data: null, error: null };

    if (this.operation === 'read') {
      return { data: { id: existing.id }, error: null };
    }

    assert.equal(this.operation, 'update');
    assert.ok(this.eventCreatedAt);

    const currentTime = existing.last_event_at
      ? new Date(existing.last_event_at).getTime()
      : Number.NEGATIVE_INFINITY;
    const incomingTime = new Date(this.eventCreatedAt).getTime();
    if (currentTime >= incomingTime) return { data: null, error: null };

    this.database.rows.set(this.subscriptionId, {
      ...existing,
      ...this.payload,
      id: existing.id,
      stripe_subscription_id: this.subscriptionId,
      last_event_at: this.eventCreatedAt,
    });
    return { data: { id: existing.id }, error: null };
  }
}

class FakeUsersQuery {
  constructor(private readonly database: FakeSubscriptions) {}

  select(column: string) {
    assert.equal(column, 'id');
    return this;
  }

  eq(column: string, value: string) {
    assert.equal(column, 'id');
    assert.equal(value, 'user-1');
    return this;
  }

  async maybeSingle() {
    return {
      data: this.database.userExists ? { id: 'user-1' } : null,
      error: null,
    };
  }
}

function eventRow(status: string, lastEventAt: string, userId = 'user-1') {
  return {
    user_id: userId,
    plan: 'starter',
    billing_period: 'monthly',
    status,
    stripe_subscription_id: 'sub_123',
    last_event_at: lastEventAt,
  };
}

test('a first Stripe subscription event inserts the local snapshot', async () => {
  const database = new FakeSubscriptions();
  const result = await applySubscriptionEvent(
    database,
    eventRow('trialing', '2026-07-30T10:00:00.000Z'),
  );

  assert.equal(result, 'inserted');
  assert.equal(database.rows.get('sub_123')?.status, 'trialing');
});

test('a newer Stripe event updates the subscription and an older one cannot restore it', async () => {
  const database = new FakeSubscriptions();
  await applySubscriptionEvent(database, eventRow('active', '2026-07-30T10:00:00.000Z'));
  await applySubscriptionEvent(database, eventRow('canceled', '2026-07-30T10:05:00.000Z'));

  const stale = await applySubscriptionEvent(
    database,
    eventRow('active', '2026-07-30T10:01:00.000Z'),
  );

  assert.equal(stale, 'stale_or_missing');
  assert.equal(database.rows.get('sub_123')?.status, 'canceled');
  assert.equal(database.rows.get('sub_123')?.last_event_at, '2026-07-30T10:05:00.000Z');
});

test('a metadata-less Stripe event may update an existing row but cannot create one', async () => {
  const database = new FakeSubscriptions();
  const missing = await applySubscriptionEvent(
    database,
    eventRow('active', '2026-07-30T10:00:00.000Z', ''),
  );
  assert.equal(missing, 'stale_or_missing');
  assert.equal(database.rows.size, 0);

  await applySubscriptionEvent(database, eventRow('trialing', '2026-07-30T10:01:00.000Z'));
  const updated = await applySubscriptionEvent(
    database,
    eventRow('active', '2026-07-30T10:02:00.000Z', ''),
  );
  assert.equal(updated, 'updated');
  assert.equal(database.rows.get('sub_123')?.status, 'active');
});

test('a concurrent first delivery still leaves the newest Stripe event stored', async () => {
  const database = new FakeSubscriptions();
  database.concurrentInsert = {
    id: 'concurrent-row',
    ...eventRow('trialing', '2026-07-30T10:00:00.000Z'),
  };

  const result = await applySubscriptionEvent(
    database,
    eventRow('active', '2026-07-30T10:01:00.000Z'),
  );

  assert.equal(result, 'updated');
  assert.equal(database.rows.get('sub_123')?.status, 'active');
  assert.equal(database.rows.get('sub_123')?.id, 'concurrent-row');
});

test('a different live subscription for the same user is surfaced as an operational conflict', async () => {
  const database = new FakeSubscriptions();
  database.conflictingLiveUser = true;

  await assert.rejects(
    applySubscriptionEvent(database, eventRow('active', '2026-07-30T10:01:00.000Z')),
    (error: unknown) => {
      assert.ok(error instanceof LiveSubscriptionConflictError);
      assert.equal(error.userId, 'user-1');
      assert.equal(error.incomingSubscriptionId, 'sub_123');
      return true;
    }
  );
});

test('a late Stripe event after account deletion is completed without recreating the user', async () => {
  const database = new FakeSubscriptions();
  database.deletedUserForeignKey = true;
  database.userExists = false;

  const result = await applySubscriptionEvent(
    database,
    eventRow('canceled', '2026-07-30T10:01:00.000Z'),
  );

  assert.equal(result, 'ignored_deleted_user');
  assert.equal(database.rows.size, 0);
});

test('an unexpected foreign-key failure is not hidden while the user still exists', async () => {
  const database = new FakeSubscriptions();
  database.deletedUserForeignKey = true;

  await assert.rejects(
    applySubscriptionEvent(database, eventRow('active', '2026-07-30T10:01:00.000Z')),
    /Failed to insert Stripe subscription event/,
  );
});
