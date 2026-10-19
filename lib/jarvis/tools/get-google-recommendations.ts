import type { EvidenceRow, JarvisReadTool } from './types';
import { cleanText, enumLabel, num, okResult, parseArgs, pick, refCounter, round, str, tryQuery } from './shared';
import { classifyGoogleRecommendation, summarizeVerdicts } from '@/lib/recommendations/google-triage';
import { readSubscriptions } from '@/lib/ai/extended-actions/preflight';

/**
 * Google's own recommendations with a verdict for each (accept, reject or
 * needs_review) and the auto-apply state. Registered only when
 * EXTENDED_ACTIONS_ENABLED is on.
 *
 * Resource names stay in the evidence rows; the summary the model sees has
 * only refs, types, Arabic reasons and numbers.
 */

const MAX_ITEMS = 25;

const FULL_QUERY = `
  SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed,
    recommendation.campaign,
    recommendation.impact.base_metrics.impressions, recommendation.impact.base_metrics.clicks,
    recommendation.impact.base_metrics.cost_micros, recommendation.impact.base_metrics.conversions,
    recommendation.impact.potential_metrics.impressions, recommendation.impact.potential_metrics.clicks,
    recommendation.impact.potential_metrics.cost_micros, recommendation.impact.potential_metrics.conversions
  FROM recommendation
`;
// If a metrics field is rejected by the API version in use, the list still loads without impact numbers.
const MINIMAL_QUERY = `
  SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.campaign
  FROM recommendation
`;

const AUTO_APPLY_HINT_AR = 'لو فيه تطبيق تلقائي شغال وما قدرنا نوقفه من هنا، اطفه من الإعدادات: قوقل أدز، التوصيات، التطبيق التلقائي';

function impactOf(row: unknown, side: 'base_metrics' | 'potential_metrics') {
  const base = `recommendation.impact.${side}`;
  const clicks = num(row, `${base}.clicks`);
  const impressions = num(row, `${base}.impressions`);
  const cost = num(row, `${base}.cost_micros`);
  const conversions = num(row, `${base}.conversions`);
  if (clicks === null && impressions === null && cost === null && conversions === null) return null;
  return {
    impressions: impressions === null ? null : round(impressions, 0),
    clicks: clicks === null ? null : round(clicks, 1),
    cost: cost === null ? null : round(cost / 1_000_000, 2),
    conversions: conversions === null ? null : round(conversions, 2),
  };
}

export const getGoogleRecommendationsTool: JarvisReadTool = {
  name: 'get_google_recommendations',
  description:
    "Lists Google's own open recommendations for the account with a verdict for each (accept, reject, needs_review) and an Arabic reason, plus whether auto-apply is on. Use it before suggesting to apply or dismiss a Google recommendation. Never apply by yourself.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);

    let rows = await tryQuery(ctx, 'google_recommendations', FULL_QUERY);
    if (rows === null) rows = await tryQuery(ctx, 'google_recommendations_minimal', MINIMAL_QUERY);
    if (rows === null) throw new Error('recommendations unreadable');

    const [conversionRows, campaignRows, subscriptions] = await Promise.all([
      tryQuery(ctx, 'rec_conversions', 'SELECT metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS'),
      tryQuery(ctx, 'rec_campaigns', 'SELECT campaign.resource_name, campaign.name FROM campaign'),
      readSubscriptions(ctx.customer).catch(() => null),
    ]);

    const conversions30d = conversionRows
      ? conversionRows.reduce((sum: number, row: unknown) => sum + (num(row, 'metrics.conversions') ?? 0), 0)
      : null;
    const names = new Map<string, string>();
    for (const row of campaignRows ?? []) names.set(str(row, 'campaign.resource_name'), str(row, 'campaign.name'));

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const items: Array<Record<string, unknown>> = [];
    const verdicts: Array<{ verdict: 'accept' | 'reject' | 'needs_review' }> = [];

    for (const row of rows) {
      if (pick(row, 'recommendation.dismissed') === true) continue;
      const type = enumLabel(str(row, 'recommendation.type'), 'UNKNOWN');
      const resource = str(row, 'recommendation.resource_name');
      if (!resource) continue;
      const result = classifyGoogleRecommendation(
        { type },
        // Target-met is not known at this layer: unknown counts as not proven.
        { conversions_30d: conversions30d, target_met: null }
      );
      verdicts.push(result);
      if (items.length >= MAX_ITEMS) continue;

      const ref = nextRef('gr');
      const campaignResource = str(row, 'recommendation.campaign');
      const compact = {
        type,
        verdict: result.verdict,
        reason_ar: result.reason_ar,
        applicable: result.applicable,
        campaign: cleanText(names.get(campaignResource) ?? '') || null,
        impact_now: impactOf(row, 'base_metrics'),
        impact_potential: impactOf(row, 'potential_metrics'),
      };
      evidence.push({
        ref,
        kind: 'google_recommendation',
        data: { ...compact, resource_name: resource, campaign_resource: campaignResource || null },
      });
      items.push({ ref, ...compact });
    }

    const enabled = (subscriptions ?? []).filter((s: { status: string }) => s.status === 'ENABLED');
    let autoApply: Record<string, unknown>;
    if (subscriptions === null) {
      autoApply = { readable: false, note_ar: AUTO_APPLY_HINT_AR };
    } else {
      const ref = nextRef('aa');
      evidence.push({
        ref,
        kind: 'auto_apply',
        data: {
          subscription_resources: enabled.map((s: { resource_name: string }) => s.resource_name),
          types: enabled.map((s: { type: string }) => s.type),
        },
      });
      autoApply = {
        readable: true,
        ref: enabled.length > 0 ? ref : undefined,
        enabled_count: enabled.length,
        enabled_types: enabled.map((s: { type: string }) => enumLabel(s.type, 'UNKNOWN')).slice(0, 30),
        note_ar:
          enabled.length > 0
            ? 'فيه توصيات قوقل تتطبق تلقائي على حسابك. نقدر نوقفها بعد موافقتك، أو اطفه من الإعدادات'
            : 'ما فيه تطبيق تلقائي شغال',
      };
    }

    return okResult(
      {
        total_open: verdicts.length,
        shown: items.length,
        by_verdict: summarizeVerdicts(verdicts),
        conversions_30d: conversions30d === null ? null : round(conversions30d, 1),
        recommendations: items,
        auto_apply: autoApply,
      },
      evidence
    );
  },
};
