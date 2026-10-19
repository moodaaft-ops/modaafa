/**
 * Switches for the weekly and monthly media-buyer loops (GAP-144 items 23 to 46).
 *
 * Every one defaults OFF. With a switch off, the code path it guards must not
 * run at all: no extra Google Ads query, no extra database read, no extra
 * words in a prompt. Only the exact string "true" turns a switch on.
 */

type Env = Record<string, string | undefined>;

function on(name: string, env: Env) {
  return env[name]?.trim().toLowerCase() === 'true';
}

/** N-gram analysis of search terms (optimizer snapshot block and the Jarvis read tool). */
export function isNgramEnabled(env: Env = process.env) {
  return on('NGRAM_ENABLED', env);
}

/** The optimizer reads past measured outcomes, suppresses repeats that hurt, and measures against a control group. */
export function isOutcomeMemoryEnabled(env: Env = process.env) {
  return on('OUTCOME_MEMORY_ENABLED', env);
}

/** Saudi season calendar in the optimizer and the monthly session. */
export function isSeasonsEnabled(env: Env = process.env) {
  return on('SEASONS_ENABLED', env);
}

/** Merchant-stated facts (offer, stock out, price change, busy hours) saved by Jarvis and read by the loops. */
export function isBusinessMemoryEnabled(env: Env = process.env) {
  return on('BUSINESS_MEMORY_ENABLED', env);
}

/** The monthly deep session on the Opus tier (cron, auction insights, quality score, money report). */
export function isMonthlyReviewEnabled(env: Env = process.env) {
  return on('MONTHLY_REVIEW_ENABLED', env);
}

/** True when any switch that changes what the hourly optimizer reads or proposes is on. */
export function anyOptimizerLoopEnabled(env: Env = process.env) {
  return isNgramEnabled(env) || isOutcomeMemoryEnabled(env) || isSeasonsEnabled(env) || isBusinessMemoryEnabled(env);
}
