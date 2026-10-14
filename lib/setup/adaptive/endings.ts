import type { FirstCampaignPlan, Scenario } from './types';

/** CONTRACT (part B): the first-campaign plan for new, dormant and no_account. No audit, no model. */
export function firstCampaignPlan(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  business: { monthlyBudget: number | null; targetRegions: string[]; website: string | null } | null;
  currency: string;
}): FirstCampaignPlan | null {
  void args;
  return null;
}

/** CONTRACT (part B): questions to put to the agency, from the audit's decision categories and titles. */
export function agencyQuestions(decisions: Array<{ title: string; category: string | null }>): string[] {
  void decisions;
  return [];
}

/** Shown at the end of the agency ending. One switch, so Ayman can drop it. */
export const AGENCY_FULL_MANAGEMENT_CARD = true;
