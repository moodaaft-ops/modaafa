import { mapConvertingTermRows } from '../ai/opportunity';
import { collectAdsStudioRead, buildAssetProposals, loadBusinessFacts, queueAssetCards, type AdsStudioRead } from './proposals';
import { defaultWriterDeps } from './writer';

/** A pending card, or any card made in the last 14 days (including dismissed), blocks a new one. */
export const CARD_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export async function hasBlockingCard(supabase: any, accountId: string, fingerprint: string, now = Date.now()): Promise<boolean> {
  const { data } = await supabase
    .from('recommendations')
    .select('status, created_at')
    .eq('account_id', accountId)
    .eq('fingerprint', fingerprint)
    .limit(5);
  return (data ?? []).some(
    (row: any) => row.status === 'pending' || now - new Date(row.created_at).getTime() < CARD_COOLDOWN_MS
  );
}

export const runAdsStudioProposals = {
  read(customer: any): Promise<AdsStudioRead | null> {
    return collectAdsStudioRead(customer);
  },

  /** Never auto-executes: the cards are inserted as pending recommendations only. */
  async queue(args: {
    supabase: any;
    read: AdsStudioRead;
    customer: any;
    accountId: string;
    customerId: string;
    businessId: string | null;
    customerName: string | null;
    sector: string | null;
    convertingTermRows: any[];
  }): Promise<{ queued: number; skipped: Array<{ what: string; why: string }> }> {
    const facts = await loadBusinessFacts(args.supabase, args.businessId);
    const topTerms = mapConvertingTermRows(args.convertingTermRows)
      .slice(0, 10)
      .map((row) => ({ term: row.term, conversions: row.conversions }));
    const report = await buildAssetProposals(
      {
        accountId: args.accountId,
        customerId: args.customerId,
        report: args.read.report,
        coverage: args.read.coverage,
        reader: { query: (gaql: string) => args.customer.query(gaql) },
        business: { name: args.customerName, sector: args.sector, facts },
        topTerms,
      },
      {
        writer: defaultWriterDeps({ accountId: args.accountId }),
        hasBlocking: (fingerprint) => hasBlockingCard(args.supabase, args.accountId, fingerprint),
      }
    );
    const queued = await queueAssetCards(args.supabase, args.accountId, report.cards);
    return { queued, skipped: report.skipped };
  },
};
