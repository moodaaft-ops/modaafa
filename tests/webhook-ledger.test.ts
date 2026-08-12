import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
} from '../lib/billing/webhook-ledger';

type LedgerRow = {
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_attempt_at: string;
  completed_at?: string | null;
  error_message?: string | null;
};

class FakeWebhookLedger {
  rows = new Map<string, LedgerRow>();
  loseNextConditionalUpdate = false;

  from(table: string) {
    assert.equal(table, 'processed_webhook_events');
    return new FakeLedgerQuery(this);
  }
}

class FakeLedgerQuery implements PromiseLike<{ error: null }> {
  private operation: 'read' | 'update' | null = null;
  private payload: Record<string, unknown> = {};
  private filters = new Map<string, unknown>();

  constructor(private readonly database: FakeWebhookLedger) {}

  async insert(payload: LedgerRow) {
    if (this.database.rows.has(payload.event_id)) return { error: { code: '23505' } };
    this.database.rows.set(payload.event_id, { ...payload });
    return { error: null };
  }

  update(payload: Record<string, unknown>) {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  select() {
    if (!this.operation) this.operation = 'read';
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.set(column, value);
    return this;
  }

  async maybeSingle() {
    const row = this.matchingRow();
    if (this.operation === 'read') {
      return { data: row ? { ...row } : null, error: null };
    }

    if (!row || this.database.loseNextConditionalUpdate) {
      this.database.loseNextConditionalUpdate = false;
      return { data: null, error: null };
    }

    Object.assign(row, this.payload);
    return { data: { event_id: row.event_id }, error: null };
  }

  then<TResult1 = { error: null }, TResult2 = never>(
    onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const row = this.matchingRow();
    if (row && this.operation === 'update') Object.assign(row, this.payload);
    return Promise.resolve(onfulfilled ? onfulfilled({ error: null }) : ({ error: null } as TResult1));
  }

  private matchingRow() {
    const eventId = String(this.filters.get('event_id') ?? '');
    const row = this.database.rows.get(eventId);
    if (!row) return null;
    for (const [column, expected] of this.filters) {
      if ((row as unknown as Record<string, unknown>)[column] !== expected) return null;
    }
    return row;
  }
}

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

test('the first Stripe delivery acquires a durable processing claim', async () => {
  const database = new FakeWebhookLedger();
  const result = await claimStripeWebhookEvent(database, 'evt_1', 'invoice.payment_succeeded', {
    nowMs: NOW,
  });

  assert.equal(result, 'claimed');
  assert.deepEqual(database.rows.get('evt_1'), {
    event_id: 'evt_1',
    event_type: 'invoice.payment_succeeded',
    status: 'processing',
    attempts: 1,
    last_attempt_at: '2026-08-12T12:00:00.000Z',
  });
});

test('completed Stripe deliveries are acknowledged without running side effects twice', async () => {
  const database = new FakeWebhookLedger();
  database.rows.set('evt_1', {
    event_id: 'evt_1',
    event_type: 'invoice.payment_succeeded',
    status: 'completed',
    attempts: 1,
    last_attempt_at: '2026-08-12T11:59:00.000Z',
  });

  assert.equal(
    await claimStripeWebhookEvent(database, 'evt_1', 'invoice.payment_succeeded', { nowMs: NOW }),
    'already_completed',
  );
});

test('a fresh in-flight event is not acknowledged with 2xx semantics', async () => {
  const database = new FakeWebhookLedger();
  database.rows.set('evt_1', {
    event_id: 'evt_1',
    event_type: 'customer.subscription.deleted',
    status: 'processing',
    attempts: 1,
    last_attempt_at: '2026-08-12T11:59:00.000Z',
  });

  assert.equal(
    await claimStripeWebhookEvent(database, 'evt_1', 'customer.subscription.deleted', { nowMs: NOW }),
    'in_flight',
  );
  assert.equal(database.rows.get('evt_1')?.attempts, 1);
});

test('a stale or failed event can be reclaimed exactly once', async () => {
  const database = new FakeWebhookLedger();
  database.rows.set('evt_1', {
    event_id: 'evt_1',
    event_type: 'customer.subscription.updated',
    status: 'processing',
    attempts: 2,
    last_attempt_at: '2026-08-12T11:00:00.000Z',
  });

  assert.equal(
    await claimStripeWebhookEvent(database, 'evt_1', 'customer.subscription.updated', { nowMs: NOW }),
    'claimed',
  );
  assert.equal(database.rows.get('evt_1')?.attempts, 3);
  assert.equal(database.rows.get('evt_1')?.last_attempt_at, '2026-08-12T12:00:00.000Z');

  assert.equal(
    await claimStripeWebhookEvent(database, 'evt_1', 'customer.subscription.updated', { nowMs: NOW + 1 }),
    'in_flight',
  );
});

test('a competing stale reclaimer that loses the compare-and-swap remains in flight', async () => {
  const database = new FakeWebhookLedger();
  database.rows.set('evt_1', {
    event_id: 'evt_1',
    event_type: 'customer.subscription.updated',
    status: 'failed',
    attempts: 2,
    last_attempt_at: '2026-08-12T11:00:00.000Z',
  });
  database.loseNextConditionalUpdate = true;

  assert.equal(
    await claimStripeWebhookEvent(database, 'evt_1', 'customer.subscription.updated', { nowMs: NOW }),
    'in_flight',
  );
});

test('completion and failure transitions are explicit and completion fails if the claim was lost', async () => {
  const database = new FakeWebhookLedger();
  await claimStripeWebhookEvent(database, 'evt_1', 'invoice.payment_succeeded', { nowMs: NOW });
  await completeStripeWebhookEvent(database, 'evt_1', '2026-08-12T12:00:10.000Z');
  assert.equal(database.rows.get('evt_1')?.status, 'completed');

  await assert.rejects(
    completeStripeWebhookEvent(database, 'evt_missing', '2026-08-12T12:00:10.000Z'),
    /claim was lost/,
  );

  database.rows.set('evt_2', {
    event_id: 'evt_2',
    event_type: 'invoice.payment_failed',
    status: 'processing',
    attempts: 1,
    last_attempt_at: '2026-08-12T12:00:00.000Z',
  });
  await failStripeWebhookEvent(database, 'evt_2', 'x'.repeat(1200), '2026-08-12T12:00:05.000Z');
  assert.equal(database.rows.get('evt_2')?.status, 'failed');
  assert.equal(database.rows.get('evt_2')?.error_message?.length, 1000);
});
