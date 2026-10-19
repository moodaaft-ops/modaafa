/**
 * The words the optimizer prompt gets when one of the loop blocks is present.
 *
 * The system prompt stays exactly as it was (it is cached and shared by every
 * account); these lines ride in the user message, after <account_data>, and
 * only when at least one block exists. With every loop switch off the snapshot
 * carries none of the blocks and this returns an empty string, so the prompt is
 * byte for byte what it was.
 *
 * Types only: this file is imported by optimizer-agent.ts, so it must not
 * import anything that imports optimizer-agent back.
 */

type LoopBlocks = {
  ngram_analysis?: unknown;
  outcome_memory?: unknown;
  season_context?: unknown;
  merchant_context?: unknown;
  store_revenue?: unknown;
};

export function loopsPromptAddendum(snapshot: LoopBlocks): string {
  const lines: string[] = [];
  if (snapshot.ngram_analysis) {
    lines.push(
      '- ngram_analysis: search terms broken into 1, 2 and 3 word pieces with cost, clicks and conversions per piece. ' +
        'wasteful[] are pieces with zero conversions that cost at least 2 x allowable_cpa (the waste limit), in at least 2 terms. ' +
        'Use it to choose add_negative_keyword for a repeating piece (PHRASE), citing the piece and its cost; the wasted_search_terms rules and all server checks still apply. ' +
        'Never negate a piece that appears in winners[] or in the business words.'
    );
  }
  if (snapshot.outcome_memory) {
    lines.push(
      '- outcome_memory: measured results of earlier changes on THIS account (last 90 days). Prefer the kinds of change that worked. ' +
        'Do not propose again a change that is listed in did_not_work on the same entity: the server drops it.'
    );
  }
  if (snapshot.season_context) {
    lines.push(
      '- season_context: the Saudi calendar around today. When judgement_unreliable is true the last 7 days sit inside a season or just after it: ' +
        'do not read a week over week swing as a verdict, and propose no budget cut because of it. upcoming[] with in_prep_window true is a reason to prepare, ' +
        'never a reason to skip a gate: a raise still needs every condition of the adjust_budget rule.'
    );
  }
  if (snapshot.merchant_context) {
    lines.push(
      '- merchant_context: what the owner told us about the coming days (offer, stock-out, price change, busy hours). Respect it in reason_ar and in what you propose.'
    );
  }
  if (snapshot.store_revenue) {
    lines.push(
      '- store_revenue: real orders from the merchant store against the value Google reports for the same 30 days. ' +
        'google_to_store_ratio above 1.25 means Google over-reports: do not scale budget or loosen targets on Google value alone. ' +
        'Below 0.6 means tracking misses sales. Evidence only; every rule and server check above still applies.'
    );
  }
  if (lines.length === 0) return '';
  return `\nLoop context (data about this account, same rules as above):\n${lines.join('\n')}`;
}
