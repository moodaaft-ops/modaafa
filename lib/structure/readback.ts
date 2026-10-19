import type { OptimizerAction } from '../ai/optimizer-agent';
import { esc } from '../ads/rows';
import { readCampaignFacts } from './preflight';

/**
 * Reads the account back after a live mutate and says whether the change is
 * there. Never throws and never undoes anything.
 */

export type StructureReadback = { status: 'verified' | 'mismatch' | 'unavailable'; detail?: string };

const ok = (): StructureReadback => ({ status: 'verified' });
const mismatch = (detail: string): StructureReadback => ({ status: 'mismatch', detail });
const pick = (o: any, camel: string, snake: string) => (o && typeof o === 'object' ? (o[camel] !== undefined ? o[camel] : o[snake]) : undefined);

export async function readbackStructureAction(action: OptimizerAction, customer: any): Promise<StructureReadback> {
  try {
    const params = action.params as Record<string, any>;
    const resolved = (params.resolved ?? {}) as Record<string, any>;

    switch (action.type) {
      case 'set_ai_max': {
        const [c] = await readCampaignFacts(customer, [params.campaign_resource]);
        if (!c) return mismatch('campaign not found');
        return c.ai_max === params.enabled ? ok() : mismatch('ai max setting differs');
      }

      case 'add_placement_exclusions': {
        const rows =
          params.level === 'account'
            ? await customer.query(`SELECT customer_negative_criterion.placement.url, customer_negative_criterion.youtube_channel.channel_id, customer_negative_criterion.youtube_video.video_id, customer_negative_criterion.mobile_application.app_id, customer_negative_criterion.content_label.type FROM customer_negative_criterion`)
            : await customer.query(`SELECT campaign_criterion.placement.url, campaign_criterion.youtube_channel.channel_id, campaign_criterion.youtube_video.video_id, campaign_criterion.mobile_application.app_id, campaign_criterion.content_label.type FROM campaign_criterion WHERE campaign_criterion.campaign = '${esc(params.campaign_resource)}' AND campaign_criterion.negative = TRUE`);
        const live = new Set<string>();
        for (const row of rows ?? []) {
          const c = params.level === 'account' ? pick(row, 'customerNegativeCriterion', 'customer_negative_criterion') : pick(row, 'campaignCriterion', 'campaign_criterion');
          if (!c) continue;
          const url = c.placement?.url;
          if (url) live.add(`website:${String(url).toLowerCase().replace(/^www\./, '')}`);
          const ch = pick(c.youtubeChannel ?? c.youtube_channel, 'channelId', 'channel_id');
          if (ch) live.add(`youtube_channel:${ch}`);
          const v = pick(c.youtubeVideo ?? c.youtube_video, 'videoId', 'video_id');
          if (v) live.add(`youtube_video:${v}`);
          const a = pick(c.mobileApplication ?? c.mobile_application, 'appId', 'app_id');
          if (a) live.add(`mobile_app:${a}`);
          const l = (c.contentLabel ?? c.content_label)?.type;
          if (l) live.add(`content_label:${l}`);
        }
        const missing = (resolved.to_create ?? []).filter((p: any) => !live.has(`${p.kind}:${p.value}`));
        return missing.length === 0 ? ok() : mismatch(`${missing.length} placement(s) missing`);
      }

      case 'create_shared_budget':
      case 'attach_shared_budget':
      case 'detach_shared_budget': {
        const resources: string[] = params.campaign_resources ?? [params.campaign_resource];
        const live = await readCampaignFacts(customer, resources);
        if (live.length !== resources.length) return mismatch('campaign not found');
        if (action.type === 'detach_shared_budget') {
          return live.every((c) => !c.budget_shared && c.budget !== resolved.shared_budget) ? ok() : mismatch('campaign still on the shared budget');
        }
        const budgets = new Set(live.map((c) => c.budget));
        if (budgets.size !== 1 || !live.every((c) => c.budget_shared)) return mismatch('campaigns do not spend from one shared budget');
        if (action.type === 'attach_shared_budget' && !budgets.has(params.budget_resource)) return mismatch('wrong shared budget');
        if (action.type === 'create_shared_budget' && live[0].budget_amount_micros !== params.amount_micros) return mismatch('shared budget amount differs');
        return ok();
      }

      case 'create_portfolio_strategy':
      case 'attach_portfolio_strategy':
      case 'detach_portfolio_strategy': {
        const resources: string[] = params.campaign_resources ?? [params.campaign_resource];
        const live = await readCampaignFacts(customer, resources);
        if (live.length !== resources.length) return mismatch('campaign not found');
        if (action.type === 'detach_portfolio_strategy') {
          return live.every((c) => !c.portfolio) ? ok() : mismatch('campaign still uses the portfolio strategy');
        }
        const strategies = new Set(live.map((c) => c.portfolio));
        if (strategies.size !== 1 || !live[0].portfolio) return mismatch('campaigns do not share one portfolio strategy');
        if (action.type === 'attach_portfolio_strategy' && live[0].portfolio !== params.strategy_resource) return mismatch('wrong strategy');
        return ok();
      }

      case 'subdivide_shopping_listing_group': {
        const rows = await customer.query(`SELECT ad_group_criterion.listing_group.type FROM ad_group_criterion WHERE ad_group_criterion.ad_group = '${esc(params.ad_group_resource)}' AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED'`);
        const want = (params.values?.length ?? 0) + 2; // root + values + everything else
        return (rows ?? []).length === want ? ok() : mismatch(`expected ${want} nodes, found ${(rows ?? []).length}`);
      }

      case 'subdivide_pmax_listing_group': {
        const rows = await customer.query(`SELECT asset_group_listing_group_filter.type FROM asset_group_listing_group_filter WHERE asset_group_listing_group_filter.asset_group = '${esc(params.asset_group_resource)}'`);
        const want = (params.values?.length ?? 0) + 2;
        return (rows ?? []).length === want ? ok() : mismatch(`expected ${want} nodes, found ${(rows ?? []).length}`);
      }
    }
    return { status: 'unavailable', detail: 'no_readback_for_type' };
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message.slice(0, 200) : 'read_failed' };
  }
}
