import { buildLaunchPlan, type LaunchContext } from './plan';
import { createBuildCard } from './recommendation';
import { resolveRegionConstants, type SuggestRequest } from './geo';
import type { LaunchPlan } from './types';

/**
 * Draft to plan to pending card. The plan is built here, on the server, from
 * the stored builder draft; the browser never sends a plan.
 */

type Rec = Record<string, any>;

function regionNames(draft: unknown): string[] {
  const d = (draft && typeof draft === 'object' ? draft : {}) as Rec;
  const names: string[] = [];
  for (const target of Array.isArray(d.geo_targets) ? d.geo_targets : []) {
    for (const region of Array.isArray(target?.regions) ? target.regions : []) names.push(String(region ?? ''));
  }
  for (const region of Array.isArray(d.target_regions) ? d.target_regions : []) names.push(String(region ?? ''));
  return Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).slice(0, 10);
}

export async function proposeLaunch(args: {
  admin: any;
  accountId: string;
  draft: unknown;
  context: Omit<LaunchContext, 'resolvedRegions'>;
  suggest: SuggestRequest;
}): Promise<{ plan: LaunchPlan; cardId: string | null }> {
  const names = regionNames(args.draft);
  let resolvedRegions: Record<string, string> = {};
  if (names.length > 0) {
    try {
      resolvedRegions = await resolveRegionConstants(names, args.suggest);
    } catch {
      // Unresolved names become a blocker on the plan; nothing silently widens to the whole country.
      resolvedRegions = {};
    }
  }
  const plan = buildLaunchPlan(args.draft, { ...args.context, resolvedRegions });
  if (!plan.executable) return { plan, cardId: null };
  const card = await createBuildCard(args.admin, args.accountId, plan);
  return { plan, cardId: card.id };
}
