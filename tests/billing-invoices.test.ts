import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invoicePaidAt,
  minorUnitsToAmount,
  recordPaidInvoice,
} from '../lib/billing/invoices';

function fakeSupabase(insertResult: { error: unknown }) {
  const calls: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          calls.push({ table, row });
          return insertResult;
        },
      };
    },
  };
  return { client, calls };
}

test('minor units convert per currency exponent', () => {
  assert.equal(minorUnitsToAmount(50_000, 'sar'), 500); // 2 decimals
  assert.equal(minorUnitsToAmount(50_000, 'SAR'), 500); // case-insensitive
  assert.equal(minorUnitsToAmount(500, 'jpy'), 500); // zero decimals
  assert.equal(minorUnitsToAmount(5_000, 'kwd'), 5); // three decimals
  assert.equal(minorUnitsToAmount(1234, undefined), 12.34); // defaults to SAR
});

test("paid_at uses Stripe's own transition time, not webhook processing time", () => {
  const paid = invoicePaidAt({ status_transitions: { paid_at: 1_754_000_000 }, created: 1_753_000_000 });
  assert.equal(paid, new Date(1_754_000_000 * 1000).toISOString());
});

test('paid_at falls back to invoice.created when transitions are missing', () => {
  const paid = invoicePaidAt({ status_transitions: null, created: 1_753_000_000 });
  assert.equal(paid, new Date(1_753_000_000 * 1000).toISOString());
});

test('records the invoice with a plain insert (no ON CONFLICT arbiter needed)', async () => {
  const { client, calls } = fakeSupabase({ error: null });
  const result = await recordPaidInvoice(client, {
    subscriptionRowId: 'sub-row-1',
    userId: 'user-1',
    invoice: {
      id: 'in_123',
      number: 'MDF-0001',
      amount_paid: 120_000,
      currency: 'sar',
      hosted_invoice_url: 'https://invoice.stripe.com/x',
      status_transitions: { paid_at: 1_754_000_000 },
      created: 1_753_999_000,
    },
  });

  assert.deepEqual(result, { recorded: true, duplicate: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'invoices');
  assert.equal(calls[0].row.invoice_number, 'MDF-0001');
  assert.equal(calls[0].row.amount_sar, 1200);
  assert.equal(calls[0].row.currency, 'SAR');
  assert.equal(calls[0].row.status, 'paid');
  assert.equal(calls[0].row.user_id, 'user-1');
  assert.equal(calls[0].row.subscription_id, 'sub-row-1');
  assert.equal(calls[0].row.paid_at, new Date(1_754_000_000 * 1000).toISOString());
});

test('a concurrent re-delivery losing on the partial unique index is treated as already recorded', async () => {
  const { client } = fakeSupabase({ error: { code: '23505', message: 'duplicate key value' } });
  const result = await recordPaidInvoice(client, {
    subscriptionRowId: 'sub-row-1',
    userId: 'user-1',
    invoice: { id: 'in_123', number: 'MDF-0001', amount_paid: 1000, currency: 'sar' },
  });
  assert.deepEqual(result, { recorded: false, duplicate: true });
});

test('a non-duplicate storage error still fails the webhook so Stripe retries', async () => {
  const { client } = fakeSupabase({ error: { code: '42P10', message: 'no matching constraint' } });
  await assert.rejects(
    () =>
      recordPaidInvoice(client, {
        subscriptionRowId: 'sub-row-1',
        userId: 'user-1',
        invoice: { id: 'in_123', number: null, amount_paid: 1000, currency: 'sar' },
      }),
    /Failed to record Stripe invoice/
  );
});

test('invoice_number falls back to the Stripe invoice id so the stored key is never NULL', async () => {
  const { client, calls } = fakeSupabase({ error: null });
  await recordPaidInvoice(client, {
    subscriptionRowId: 'sub-row-1',
    userId: 'user-1',
    invoice: { id: 'in_123', number: null, amount_paid: 1000, currency: 'sar' },
  });
  assert.equal(calls[0].row.invoice_number, 'in_123');
});
