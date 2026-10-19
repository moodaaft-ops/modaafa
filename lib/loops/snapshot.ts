/**
 * Reads the loop blocks for one account of the hourly optimizer run and adds
 * them to the snapshot. Every read sits behind its own switch; with all of
 * them off this function does no I/O and returns the snapshot untouched.
 * Every read is best effort: a failure leaves that block out and never fails
 * the account.
 */

import type { OptimizerSnapshot } from '../ai/optimizer-agent';
import { ngramPromptBlock, readNgramAnalysis } from './ngram-source';
import { EMPTY_LOOPS_CONTEXT, type LoopsContext } from './filter';
import {
  isBusinessMemoryEnabled,
  isNgramEnabled,
  isOutcomeMemoryEnabled,
  isSeasonsEnabled,
} from './flags';
import { loadActiveMerchantContext, merchantContextBlock } from './merchant-context';
import { loadOutcomeRecords, whatWorkedBlock } from './outcome-memory';
import { riyadhDay, seasonContext } from './seasons';
import { isStoreSyncEnabled } from '../stores/flags';
import { loadStoreRevenue, readGoogleConversionValue, storeRevenueBlock } from '../stores/revenue';

type Env = Record<string, string | undefined>;

export async function prepareOptimizerLoops(args: {
  snapshot: OptimizerSnapshot;
  customer: { query(gaql: string): Promise<any[]> };
  supabase: any;
  accountId: string;
  businessId: string | null | undefined;
  /** Business name, sector and keywords: words the n-gram flags never touch. */
  protectedTexts?: Array<string | null | undefined>;
  now?: Date;
  env?: Env;
}): Promise<LoopsContext> {
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  const ngram = isNgramEnabled(env);
  const outcomes = isOutcomeMemoryEnabled(env);
  const seasons = isSeasonsEnabled(env);
  const business = isBusinessMemoryEnabled(env);
  const storeSync = isStoreSyncEnabled(env);
  if (!ngram && !outcomes && !seasons && !business && !storeSync) return EMPTY_LOOPS_CONTEXT;

  const today = riyadhDay(now);
  const context: LoopsContext = { outcomes: null, season: null, merchantFacts: null, today };

  if (ngram) {
    try {
      const analysis = await readNgramAnalysis({
        customer: args.customer,
        allowableCpa: args.snapshot.economics?.allowable_cpa_cut ?? null,
        protectedTexts: args.protectedTexts,
      });
      const block = analysis ? ngramPromptBlock(analysis) : null;
      if (block) args.snapshot.ngram_analysis = block;
    } catch {
      // The block is an extra; the run goes on without it.
    }
  }

  if (storeSync) {
    try {
      const googleValue = await readGoogleConversionValue(args.customer, 30);
      const to = now.toISOString();
      const from = new Date(now.getTime() - 30 * 86400000).toISOString();
      const block = storeRevenueBlock(await loadStoreRevenue(args.supabase, args.accountId, from, to, googleValue), 30);
      if (block) args.snapshot.store_revenue = block;
    } catch {
      // The comparison is an extra; the run goes on without it.
    }
  }

  if (outcomes) {
    const records = await loadOutcomeRecords(args.supabase, args.accountId, now);
    context.outcomes = records;
    const block = whatWorkedBlock(records, now);
    if (block) args.snapshot.outcome_memory = block;
  }

  if (seasons) {
    const season = seasonContext(today);
    context.season = season;
    if (season.active.length || season.recently_ended.length || season.upcoming.length) {
      args.snapshot.season_context = season;
    }
  }

  if (business) {
    const facts = await loadActiveMerchantContext(args.supabase, args.businessId, now);
    context.merchantFacts = facts;
    const block = merchantContextBlock(facts, today);
    if (block) args.snapshot.merchant_context = block;
  }

  return context;
}
