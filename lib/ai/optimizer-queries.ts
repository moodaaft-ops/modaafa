/**
 * The two Google Ads reads of the optimizer snapshot that have to degrade
 * gracefully, kept out of the cron route so they can be tested (a Next route
 * file may only export its handlers).
 */

/** How many daily conversion rows the tracking check reads. A result this long is treated as cut short. */
export const DAILY_CONVERSIONS_LIMIT = 5000;

/**
 * The campaign list with the diagnostics a media buyer reads before touching a
 * budget, from richest to plainest. A field an account's API version does not
 * accept fails the whole query, so each step drops the part most likely to be
 * rejected and keeps as much of the rest as possible:
 *
 *   1. everything: type, strategy, Google's own status and reasons, and the
 *      three impression-share fields
 *   2. what the Jarvis campaign tool reads (type, strategy and the impression
 *      shares, without the status fields): the shares are what the budget
 *      increase gate needs, so a rejected status field must not take them away
 *   3. the plain list, no diagnostics (every gate that needs them fails
 *      closed, so no budget increase)
 */
export const CAMPAIGN_QUERIES: readonly string[] = [
  `
      SELECT
        campaign.id, campaign.name, campaign.resource_name,
        campaign.advertising_channel_type, campaign.bidding_strategy_type,
        campaign.primary_status, campaign.primary_status_reasons,
        campaign_budget.id, campaign_budget.amount_micros, campaign_budget.resource_name,
        metrics.cost_micros, metrics.impressions, metrics.clicks,
        metrics.conversions, metrics.conversions_value,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND campaign.status = 'ENABLED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
    `,
  `
      SELECT
        campaign.id, campaign.name, campaign.resource_name,
        campaign.advertising_channel_type, campaign.bidding_strategy_type,
        campaign_budget.id, campaign_budget.amount_micros, campaign_budget.resource_name,
        metrics.cost_micros, metrics.impressions, metrics.clicks,
        metrics.conversions, metrics.conversions_value,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND campaign.status = 'ENABLED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
    `,
  `
      SELECT
        campaign.id, campaign.name, campaign.resource_name,
        campaign_budget.id, campaign_budget.amount_micros, campaign_budget.resource_name,
        metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND campaign.status = 'ENABLED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
    `,
];

/** Runs the campaign reads in order until one is accepted; the last one's error is the caller's. */
export async function queryCampaignRows(customer: any, customerId: string): Promise<any[]> {
  let lastError: unknown;
  for (let step = 0; step < CAMPAIGN_QUERIES.length; step += 1) {
    try {
      return await customer.query(CAMPAIGN_QUERIES[step]);
    } catch (error) {
      lastError = error;
      if (step < CAMPAIGN_QUERIES.length - 1) {
        console.warn(
          `Campaign query ${step + 1} of ${CAMPAIGN_QUERIES.length} failed for ${customerId}; trying a plainer one`,
          error
        );
      }
    }
  }
  throw lastError;
}

/**
 * Conversions per action per day for 30 days: what the "an action went silent"
 * check reads. The same shape as the Jarvis conversion-health query, which
 * Google accepts in production: no filter on the metric, because a
 * `metrics.all_conversions > 0` clause on a segmented campaign read was the
 * one thing this query had that Jarvis' does not.
 *
 * The LIMIT keeps one huge account from flooding a cron run, and the order is
 * newest first so that a result cut short loses the OLD days (a missing
 * history reads as "not enough data"), never the recent ones (which would read
 * as "went silent"). A result as long as the limit is flagged by
 * `dailyConversionsLookTruncated` and the tracking verdict ignores the history.
 */
export const DAILY_CONVERSIONS_QUERY = `
      SELECT segments.date, segments.conversion_action_name, metrics.all_conversions
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
      ORDER BY segments.date DESC
      LIMIT ${DAILY_CONVERSIONS_LIMIT}
    `;

/** True when the daily rows hit the limit, so older days may be missing. */
export function dailyConversionsLookTruncated(rows: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(rows) && rows.length >= DAILY_CONVERSIONS_LIMIT;
}

/**
 * Today's date the way Google Ads dates its days for a Saudi account
 * (`segments.date` is in the account's time zone, Riyadh, UTC+3 with no
 * daylight saving). The UTC date is one day behind between 00:00 and 03:00
 * Riyadh time, which shifted the "went silent for 5 days" window by a day.
 */
export function riyadhToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
