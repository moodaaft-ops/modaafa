/**
 * Numbers the cost readings cannot learn from the database. Anthropic does not
 * expose the prepaid balance to the platform, so the balance is a reading
 * someone took from the Anthropic console on a known date. The page subtracts
 * what the ledger recorded since then, and says plainly how old the reading is.
 *
 * To refresh it: read the balance in the Anthropic console, then update
 * `balanceUsd`, `purchasedUsd` and `readAt` here (or ask Claude to).
 */

export type AnthropicCreditReading = {
  /** Total prepaid balance shown in the console, promotional credit included. */
  balanceUsd: number;
  /** Part of the balance that was bought with real money (not promotional). */
  purchasedUsd: number;
  /** Moment the console was read. */
  readAt: string;
  /** Day (YYYY-MM-DD) the promotional part expires, when it does. */
  promoExpiresOn: string | null;
  /** Whether auto-reload is switched on in the console. */
  autoReload: boolean;
};

export const ANTHROPIC_CREDIT: AnthropicCreditReading = {
  balanceUsd: 201.24,
  purchasedUsd: 5.68,
  // Start of the Riyadh day: the reading was taken during 13 Oct 2026, so this
  // errs towards a slightly lower estimated balance, never a higher one.
  readAt: '2026-10-13T00:00:00+03:00',
  promoExpiresOn: '2026-11-07',
  autoReload: false,
};

/** A day whose model spend passes this many dollars is flagged on the cost page. */
export const DAILY_SPEND_ALERT_USD = 5;

/** A reading older than this many days is called stale on the page. */
export const CREDIT_READING_STALE_DAYS = 14;

/** Below this many days of runway the balance is flagged. */
export const RUNWAY_WARNING_DAYS = 14;
export const RUNWAY_DANGER_DAYS = 5;
