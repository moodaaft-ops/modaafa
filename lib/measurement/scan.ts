import { findTrackingGaps, totalsByDay } from './tracking-gaps';
import { loadMeasurementInputs, type Query } from './review-inputs';
import { formatAccountLocal } from './time';
import { isLeadAction, isWhatsappClickAction, LEAD_ACTION_PRIMARY_MIN_30D } from './goals';
import {
  proposeCreateLeadAction,
  proposeDataExclusions,
  proposePromoteLeadAction,
  type ProposalOutcome,
} from './proposals';

/**
 * Daily measurement scan of one account: finds a resolved tracking gap and
 * proposes a data exclusion, and walks the lead-action ladder (create it, then
 * promote it once it has volume). Reads Google, writes only pending
 * recommendations, never changes the account. Rules only, no model.
 */
type Db = any;

export type ScanSummary = {
  gaps: number;
  ongoing_silence: boolean;
  proposals: Array<{ kind: 'data_exclusion' | 'create_lead_action' | 'promote_lead_action'; outcome: ProposalOutcome }>;
  unavailable: string[];
};

export async function scanAccountMeasurement({
  query,
  admin,
  account,
  hasLeadLoopSettings,
  now = new Date(),
}: {
  query: Query;
  admin: Db;
  account: { id: string; customerId: string; currencyCode: string | null; timeZone: string | null };
  /** The merchant set up the smart link, so the lead-action ladder applies. */
  hasLeadLoopSettings: boolean;
  now?: Date;
}): Promise<ScanSummary> {
  const inputs = await loadMeasurementInputs(query);
  const summary: ScanSummary = { gaps: 0, ongoing_silence: false, proposals: [], unavailable: [] };
  if (!inputs.dailyTotals) summary.unavailable.push('daily_totals');
  if (!inputs.actions) summary.unavailable.push('goal_actions');

  const timeZone = inputs.timeZone ?? account.timeZone;

  if (inputs.dailyTotals) {
    const today = formatAccountLocal(now, timeZone).slice(0, 10);
    const result = findTrackingGaps(
      totalsByDay(
        inputs.dailyTotals.map((d) => ({ date: d.date, conversions: d.conversions })),
        inputs.dailyTotals.map((d) => ({ date: d.date, clicks: d.clicks })),
        today
      )
    );
    summary.gaps = result.gaps.length;
    summary.ongoing_silence = result.ongoing;
    // An ongoing silence is the tracking verdict's job (fix it first); only resolved windows are proposed.
    const outcomes = await proposeDataExclusions({
      admin,
      accountId: account.id,
      customerId: account.customerId,
      gaps: result.gaps,
      channelTypes: inputs.channelTypes,
      now,
    });
    for (const outcome of outcomes) summary.proposals.push({ kind: 'data_exclusion', outcome });
  }

  if (hasLeadLoopSettings && inputs.actions) {
    const lead = inputs.actions.find(isLeadAction);
    if (!lead || lead.status !== 'ENABLED') {
      if (!lead) {
        const outcome = await proposeCreateLeadAction({
          admin,
          accountId: account.id,
          customerId: account.customerId,
          currencyCode: (account.currencyCode ?? 'SAR').toUpperCase(),
          now,
        });
        summary.proposals.push({ kind: 'create_lead_action', outcome });
      }
    } else if (
      lead.resourceName &&
      lead.primaryForGoal !== true &&
      (lead.conversions30d ?? 0) >= LEAD_ACTION_PRIMARY_MIN_30D
    ) {
      const demote = inputs.actions
        .filter((action) => action.status === 'ENABLED' && action.primaryForGoal === true && isWhatsappClickAction(action))
        .map((action) => action.resourceName)
        .filter((resource): resource is string => Boolean(resource))
        .slice(0, 3);
      const outcome = await proposePromoteLeadAction({
        admin,
        accountId: account.id,
        customerId: account.customerId,
        leadActionResource: lead.resourceName,
        demoteResources: demote,
        conversions30d: lead.conversions30d ?? 0,
        now,
      });
      summary.proposals.push({ kind: 'promote_lead_action', outcome });
    }
  }

  await admin
    .from('measurement_scans')
    .upsert({ account_id: account.id, last_scan_at: now.toISOString(), last_result: summaryForStorage(summary) });
  return summary;
}

function summaryForStorage(summary: ScanSummary) {
  return {
    gaps: summary.gaps,
    ongoing_silence: summary.ongoing_silence,
    proposals: summary.proposals.map((p) => ({ kind: p.kind, created: p.outcome.created, reason: p.outcome.reason ?? null })),
    unavailable: summary.unavailable,
  };
}
