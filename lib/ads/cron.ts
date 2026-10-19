import { mapConvertingTermRows } from '../ai/opportunity';
import { collectAdsStudioRead, buildAssetProposals, loadBusinessFacts, queueAssetCards, type AdsStudioRead } from './proposals';
import { defaultWriterDeps } from './writer';
import { readAdTests } from './ad-test';
import { buildLoserPauseCards, queueLoserPauseCards } from './ad-test-cards';
import { allowableCpaCut, type BreakEven } from '../economics/break-even';
import { readAccountCallPhones, readMerchantSavedPhones, resolveVerifiedPhone } from './site-sources';
import { landingCheckEnabled } from '../landing-check/flag';
import { supabaseLandingCheckStore } from '../landing-check/store';
import type { LandingCheckReport } from '../landing-check/run';

/** The stored weekly report (no fetching here). Null when the check is off or nothing is stored. */
export async function storedLandingReport(supabase: any, accountId: string): Promise<LandingCheckReport | null> {
  if (!landingCheckEnabled()) return null;
  try {
    const latest = await supabaseLandingCheckStore(supabase).latest(accountId);
    return latest?.report ?? null;
  } catch {
    return null;
  }
}

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
    /** Optional: the ad test winner card needs healthy tracking, and uses the break-even CPA when known. */
    trackingStatus?: string | null;
    economics?: BreakEven | null;
  }): Promise<{ queued: number; skipped: Array<{ what: string; why: string }> }> {
    const facts = await loadBusinessFacts(args.supabase, args.businessId);
    const topTerms = mapConvertingTermRows(args.convertingTermRows)
      .slice(0, 10)
      .map((row) => ({ term: row.term, conversions: row.conversions }));
    const reader = { query: (gaql: string) => args.customer.query(gaql) };
    const landingReport = await storedLandingReport(args.supabase, args.accountId);
    const phone = resolveVerifiedPhone({
      merchantSaved: await readMerchantSavedPhones(args.supabase, args.businessId),
      accountPhones: (await readAccountCallPhones(reader)) ?? [],
    });
    const report = await buildAssetProposals(
      {
        landingReport,
        phone,
        accountId: args.accountId,
        customerId: args.customerId,
        report: args.read.report,
        coverage: args.read.coverage,
        reader,
        business: { name: args.customerName, sector: args.sector, facts },
        topTerms,
      },
      {
        writer: defaultWriterDeps({ accountId: args.accountId }),
        hasBlocking: (fingerprint) => hasBlockingCard(args.supabase, args.accountId, fingerprint),
      }
    );
    let queued = await queueAssetCards(args.supabase, args.accountId, report.cards);
    const skipped = [...report.skipped];
    // A decided ad test becomes a "pause the losing ad" card (approval only, with the base pause_ad rollback).
    try {
      const tests = await readAdTests(reader, { allowableCpa: allowableCpaCut(args.economics ?? null, null)?.value ?? null });
      const losers = await buildLoserPauseCards({
        accountId: args.accountId,
        customerId: args.customerId,
        tests,
        trackingStatus: args.trackingStatus,
        hasBlocking: (fingerprint) => hasBlockingCard(args.supabase, args.accountId, fingerprint),
      });
      queued += await queueLoserPauseCards(args.supabase, args.accountId, losers.cards);
      skipped.push(...losers.skipped);
    } catch {
      skipped.push({ what: 'pause_ad', why: 'ad_test_failed' });
    }
    return { queued, skipped };
  },
};
