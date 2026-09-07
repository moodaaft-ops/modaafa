import type { AutopilotCandidate } from './types';

/** Campaign negatives affect every ad group, including groups omitted by the optimizer pool. */
export async function refreshAutopilotEvidence(customer: any, action: AutopilotCandidate) {
  const campaign = String(action.params.campaign_resource ?? '');
  const term = String(action.params.keyword_text ?? '').trim();
  if (action.type !== 'add_negative_keyword' || !/^customers\/\d+\/campaigns\/\d+$/.test(campaign) || !term) {
    throw new Error('Invalid autopilot evidence target');
  }
  const rows = await customer.query(`
    SELECT campaign.resource_name, search_term_view.search_term,
      metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM search_term_view
    WHERE campaign.resource_name = '${escapeGaql(campaign)}'
      AND search_term_view.search_term = '${escapeGaql(term)}'
      AND segments.date DURING LAST_30_DAYS
  `);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No current Google evidence for autopilot');
  let clicks = 0;
  let costMicros = 0;
  let conversions = 0;
  for (const row of rows) {
    if ((row.campaign?.resourceName ?? row.campaign?.resource_name) !== campaign ||
      (row.searchTermView?.searchTerm ?? row.search_term_view?.search_term) !== term) {
      throw new Error('Google evidence did not match the autopilot target');
    }
    const metrics = row.metrics;
    const values = [metrics?.clicks, metrics?.costMicros ?? metrics?.cost_micros, metrics?.conversions];
    if (values.some((value) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw new Error('Incomplete Google evidence for autopilot');
    }
    clicks += Number(values[0]);
    costMicros += Number(values[1]);
    conversions += Number(values[2]);
  }
  return {
    ...action,
    evidence: {
      window_days: 30, clicks, conversions, cost_micros: costMicros,
      source_resource: campaign,
      relevance: action.evidence?.relevance ?? 'uncertain',
    },
  } satisfies AutopilotCandidate;
}

function escapeGaql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
