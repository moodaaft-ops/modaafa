/**
 * The amount a commission is worked out on: what the customer really paid, with
 * tax taken out. Never the list price. A trial invoice (nothing paid) returns 0.
 */

type StripeInvoiceLike = {
  amount_paid?: number | null;
  tax?: number | null;
  total_taxes?: Array<{ amount?: number | null; taxability_reason?: string | null }> | null;
};

export function commissionBaseMinor(invoice: StripeInvoiceLike): number {
  const paid = Math.max(0, invoice.amount_paid ?? 0);
  if (paid === 0) return 0;
  let tax = 0;
  if (typeof invoice.tax === 'number') tax = invoice.tax;
  else if (Array.isArray(invoice.total_taxes)) {
    tax = invoice.total_taxes.reduce((sum, line) => sum + (typeof line?.amount === 'number' ? line.amount : 0), 0);
  }
  return Math.max(0, paid - Math.max(0, tax));
}
