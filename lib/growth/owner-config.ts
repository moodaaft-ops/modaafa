/**
 * Values only Ayman can supply for the exit popup, the first-login questions
 * and the agency-lead flag. Every value starts as null. A feature that needs a
 * null value stays hidden, so nothing half-finished ever reaches a visitor.
 *
 * This is deliberately a separate file from the landing page's own owner
 * config (PR #74). When that file exists on main, move these keys into it and
 * delete this one; the names are the same on purpose.
 */

import type { AccountManagerKey, SpendBandKey } from './onboarding-answers';
import { LEAD_FOLLOWUP } from '@/config/lead-followup';

export type GrowthOwnerConfig = {
  /**
   * Link to the real sample report the popup promises. Null keeps the popup
   * hidden: promising a report that does not exist would be a lie.
   */
  sampleReportUrl: string | null;
  /**
   * Smallest monthly-spend band that marks a first-login user as an agency
   * lead. Null hides the flag in /operations. Pick a band edge, not a figure.
   */
  agencyLeadMinSpendBand: SpendBandKey | null;
  /**
   * Who manages the account today, for a user to count as an agency lead.
   * Ayman's brief says "nobody manages it". Add 'self' here if people who run
   * their own big account should count too.
   */
  agencyLeadManagers: readonly AccountManagerKey[];
};

export const GROWTH_OWNER_CONFIG: GrowthOwnerConfig = {
  sampleReportUrl: null,
  agencyLeadMinSpendBand: null,
  agencyLeadManagers: ['nobody'],
};

/** A usable sample-report link: present and https. */
export function hasSampleReportUrl(config: GrowthOwnerConfig = GROWTH_OWNER_CONFIG) {
  const url = config.sampleReportUrl?.trim();
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The exit popup shows only when BOTH hold: a real sample report link exists,
 * and Ayman has approved the follow-up email text (config/lead-followup.ts).
 * Collecting addresses we are not yet allowed to write to would be a promise
 * we cannot keep.
 */
export function exitPopupEnabled(
  config: GrowthOwnerConfig = GROWTH_OWNER_CONFIG,
  followupApproved: boolean = LEAD_FOLLOWUP.approved
) {
  return followupApproved && hasSampleReportUrl(config);
}
