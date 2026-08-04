/**
 * Invoice recording for Stripe webhook events.
 *
 * Extracted from the webhook route so the idempotency behaviour is unit-testable.
 *
 * WHY plain INSERT + tolerate 23505, not upsert:
 * the uniqueness that protects against duplicate invoice rows is the PARTIAL
 * index `invoices_user_number_uniq … WHERE invoice_number IS NOT NULL`
 * (db/schema.sql). PostgREST's `upsert({ onConflict: 'user_id,invoice_number' })`
 * emits `ON CONFLICT (user_id, invoice_number)` WITHOUT the index predicate,
 * and Postgres cannot infer a partial unique index from a bare column list —
 * every such statement fails with 42P10 ("no unique or exclusion constraint
 * matching the ON CONFLICT specification"). That made EVERY
 * `invoice.payment_succeeded` delivery throw, return 500, and retry for days,
 * while the customer's invoice list stayed empty.
 *
 * A plain INSERT needs no arbiter inference: the partial index still enforces
 * uniqueness (we always write a non-null invoice_number), a concurrent
 * re-delivery loses with SQLSTATE 23505, and we treat that as "already
 * recorded" — the exact semantics the old `ignoreDuplicates: true` intended.
 */

/**
 * Stripe amounts are in the currency's minor unit, and the exponent is not
 * always 2 (JPY has none; KWD/BHD/OMR have three).
 */
export function minorUnitsToAmount(amount: number, currency?: string | null) {
  const code = (currency ?? 'sar').toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return amount;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return amount / 1000;
  return amount / 100;
}

export const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
export const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/**
 * When the invoice was actually paid — Stripe's own transition timestamp, not
 * the moment our webhook happened to process the delivery. A retried delivery
 * three days late used to stamp the retry time as the payment date.
 */
export function invoicePaidAt(invoice: {
  status_transitions?: { paid_at?: number | null } | null;
  created?: number | null;
}): string {
  const paidAtUnix = invoice.status_transitions?.paid_at ?? invoice.created ?? null;
  return paidAtUnix ? new Date(paidAtUnix * 1000).toISOString() : new Date().toISOString();
}

export type RecordPaidInvoiceResult = { recorded: boolean; duplicate: boolean };

export async function recordPaidInvoice(
  supabase: any,
  params: {
    subscriptionRowId: string;
    userId: string;
    invoice: {
      id?: string | null;
      number?: string | null;
      amount_paid?: number | null;
      currency?: string | null;
      hosted_invoice_url?: string | null;
      status_transitions?: { paid_at?: number | null } | null;
      created?: number | null;
    };
  }
): Promise<RecordPaidInvoiceResult> {
  const { invoice } = params;
  // `invoice.number` can be null until Stripe finalizes numbering; `invoice.id`
  // always exists, so the stored key is never NULL and the partial unique
  // index always applies.
  const invoiceKey = invoice.number ?? invoice.id;

  const { error } = await supabase.from('invoices').insert({
    subscription_id: params.subscriptionRowId,
    user_id: params.userId,
    amount_sar: minorUnitsToAmount(invoice.amount_paid ?? 0, invoice.currency),
    currency: (invoice.currency ?? 'sar').toUpperCase(),
    status: 'paid',
    invoice_number: invoiceKey,
    invoice_url: invoice.hosted_invoice_url ?? null,
    paid_at: invoicePaidAt(invoice),
  });

  if (!error) return { recorded: true, duplicate: false };
  if ((error as { code?: string }).code === '23505') {
    // Another delivery of the same event (or a concurrent retry) won the
    // insert. The invoice is already on file — nothing to do.
    return { recorded: false, duplicate: true };
  }
  throw new Error('Failed to record Stripe invoice', { cause: error });
}
