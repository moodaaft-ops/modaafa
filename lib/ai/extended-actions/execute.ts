import { toFieldMask } from '../../google-ads/client';
import type { OptimizerAction } from '../optimizer-agent';
import { isExtendedOperation } from './types';
import { isAdsStudioOperation, isAdsStudioRollback } from '../../ads/studio/types';
import {
  buildAdsStudioOperations,
  buildAdsStudioRollbackOperations,
  finalizeAdsStudioRollback,
} from '../../ads/studio/execute';
import { isAdsStudioActive } from '../../ads/flag';
import { isValueRuleOperation, isValueRuleRollback } from '../../value-rules/types';
import {
  buildValueRuleOperations,
  buildValueRuleRollbackOperations,
  finalizeValueRuleRollback,
} from '../../value-rules/execute';
import { isStructureOperation, isStructureRollback } from '../../structure/types';
import {
  buildStructureOperations,
  buildStructureRollbackOperations,
  finalizeStructureRollbackPayload,
} from '../../structure/execute';

/**
 * Builds and sends the Google Ads mutate for an extended action, from the
 * `params.resolved` block that prepareExtendedAction wrote. validateOnly and
 * the live call send the SAME operations. Operations are written in snake_case;
 * the REST wrapper camelizes the keys.
 *
 * Everything except the two recommendation actions goes through ONE
 * googleAds:mutate request, which Google applies atomically (no partial
 * failure), so a shared list, its keywords and its campaign links either all
 * exist or none do.
 */

/** Resource names Google returned, in operation order (same shape contract as execution-result.ts). */
function resultResourceNames(result: any): string[] {
  const results: any[] = Array.isArray(result?.results) ? result.results : [];
  return results
    .map((entry) => entry?.resourceName ?? entry?.resource_name)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export type MutateOperation = Record<string, Record<string, unknown>>;

type Resolved = Record<string, any>;

function resolvedOf(action: OptimizerAction): Resolved {
  const resolved = (action.params as Record<string, unknown>).resolved;
  if (!resolved || typeof resolved !== 'object') {
    throw new Error('Extended action was not prepared: run prepareActionForExecution first');
  }
  return resolved as Resolved;
}

function customerIdOf(customer: any): string {
  const id = String(customer?.credentials?.customer_id ?? '').replace(/\D/g, '');
  if (!id) throw new Error('Customer id is unavailable for a mutate that needs a temporary resource name');
  return id;
}

const criterion = (op: Record<string, unknown>): MutateOperation => ({ campaign_criterion_operation: op });

export function buildMutateOperations(action: OptimizerAction, customer: any): MutateOperation[] {
  if (isAdsStudioOperation(action.type)) return buildAdsStudioOperations(action);
  if (isValueRuleOperation(action.type)) return buildValueRuleOperations(action);
  if (isStructureOperation(action.type)) return buildStructureOperations(action);
  const params = action.params as Record<string, any>;
  const resolved = resolvedOf(action);

  switch (action.type) {
    case 'set_ad_schedule': {
      const ops: MutateOperation[] = [];
      for (const r of resolved.removes as Array<{ resource_name: string }>) ops.push(criterion({ remove: r.resource_name }));
      for (const u of resolved.updates as Array<{ resource_name: string; bid_modifier: number }>) {
        ops.push(
          criterion({
            update: { resource_name: u.resource_name, bid_modifier: u.bid_modifier },
            update_mask: toFieldMask(['bid_modifier']),
          })
        );
      }
      for (const c of resolved.creates as Array<Record<string, any>>) {
        ops.push(
          criterion({
            create: {
              campaign: params.campaign_resource,
              bid_modifier: c.bid_modifier,
              ad_schedule: {
                day_of_week: c.day_of_week,
                start_hour: c.start_hour,
                start_minute: c.start_minute,
                end_hour: c.end_hour,
                end_minute: c.end_minute,
              },
            },
          })
        );
      }
      return ops;
    }

    case 'set_device_bid_modifier':
      return resolved.mode === 'update'
        ? [
            criterion({
              update: { resource_name: resolved.resource_name, bid_modifier: params.bid_modifier },
              update_mask: toFieldMask(['bid_modifier']),
            }),
          ]
        : [
            criterion({
              create: {
                campaign: params.campaign_resource,
                bid_modifier: params.bid_modifier,
                device: { type: params.device },
              },
            }),
          ];

    case 'exclude_location':
      return [
        criterion({
          create: {
            campaign: params.campaign_resource,
            negative: true,
            location: { geo_target_constant: params.geo_target_constant },
          },
        }),
      ];

    case 'set_location_bid_modifier':
      return [
        criterion({
          update: { resource_name: resolved.resource_name, bid_modifier: params.bid_modifier },
          update_mask: toFieldMask(['bid_modifier']),
        }),
      ];

    case 'set_geo_target_type':
      return [
        {
          campaign_operation: {
            update: {
              resource_name: params.campaign_resource,
              geo_target_type_setting: { positive_geo_target_type: params.positive_geo_target_type },
            },
            update_mask: toFieldMask(['geo_target_type_setting.positive_geo_target_type']),
          },
        },
      ];

    case 'set_network_settings': {
      const paths = Object.keys(resolved.changes as Record<string, boolean>);
      const settings: Record<string, boolean> = {};
      for (const path of paths) settings[path.replace('network_settings.', '')] = false;
      return [
        {
          campaign_operation: {
            update: { resource_name: params.campaign_resource, network_settings: settings },
            update_mask: toFieldMask(paths),
          },
        },
      ];
    }

    case 'create_shared_negative_list': {
      const cid = customerIdOf(customer);
      const temp = `customers/${cid}/sharedSets/-1`;
      const ops: MutateOperation[] = [
        { shared_set_operation: { create: { resource_name: temp, name: resolved.name, type: 'NEGATIVE_KEYWORDS' } } },
      ];
      for (const k of resolved.keywords as Array<{ text: string; match_type: string }>) {
        ops.push({
          shared_criterion_operation: {
            create: { shared_set: temp, keyword: { text: k.text, match_type: k.match_type } },
          },
        });
      }
      for (const campaign of resolved.campaigns as string[]) {
        ops.push({ campaign_shared_set_operation: { create: { campaign, shared_set: temp } } });
      }
      return ops;
    }

    case 'add_shared_negative_keywords':
      return (resolved.keywords as Array<{ text: string; match_type: string }>).map((k) => ({
        shared_criterion_operation: {
          create: { shared_set: params.shared_set_resource, keyword: { text: k.text, match_type: k.match_type } },
        },
      }));

    case 'attach_shared_negative_list':
      return (resolved.campaigns as string[]).map((campaign) => ({
        campaign_shared_set_operation: { create: { campaign, shared_set: params.shared_set_resource } },
      }));

    case 'pause_auto_apply':
      return (resolved.subscriptions as Array<{ resource_name: string }>).map((s) => ({
        recommendation_subscription_operation: {
          update: { resource_name: s.resource_name, status: 'PAUSED' },
          update_mask: toFieldMask(['status']),
        },
      }));

    default:
      throw new Error(`No mutate operations for ${action.type}`);
  }
}

export async function executeExtendedAction(
  action: OptimizerAction,
  customer: any,
  options?: { validateOnly?: boolean }
) {
  if (!isExtendedOperation(action.type)) throw new Error(`Not an extended action: ${action.type}`);
  if (isAdsStudioOperation(action.type) && !isAdsStudioActive()) throw new Error('Ad assets actions are disabled');
  const params = action.params as Record<string, any>;

  if (action.type === 'apply_google_recommendation' || action.type === 'dismiss_google_recommendation') {
    const resolved = resolvedOf(action);
    // RecommendationService has no validate_only. The check that stands in for
    // it is a fresh read: the recommendation must still exist and be open.
    if (options?.validateOnly) {
      const rows = await customer.query(`
        SELECT recommendation.resource_name, recommendation.dismissed
        FROM recommendation
        WHERE recommendation.resource_name = '${String(params.recommendation_resource).replace(/'/g, "\\'")}'
        LIMIT 1
      `);
      const rec = rows?.[0]?.recommendation;
      if (!rec || rec.dismissed === true) throw new Error('The Google recommendation is gone or already dismissed');
      return { validated: 'read_only_check', results: [] };
    }
    if (action.type === 'apply_google_recommendation') {
      return customer.recommendations.apply([resolved.apply_operation]);
    }
    return customer.recommendations.dismiss([{ resource_name: params.recommendation_resource }]);
  }

  const operations = buildMutateOperations(action, customer);
  if (operations.length === 0) throw new Error('Extended action produced no operations');
  return customer.mutateOperations(operations, options);
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Called by finalizeRollbackPayload once the live result is known: turns the
 * result indexes recorded at preflight into the resource names Google created,
 * and lists them among the touched resources so the scope check covers them.
 */
export function finalizeExtendedRollback(payload: Record<string, any>, result: unknown): Record<string, unknown> {
  if (isAdsStudioRollback(payload)) return finalizeAdsStudioRollback(payload, result);
  if (isValueRuleRollback(payload)) return finalizeValueRuleRollback(payload, result);
  if (isStructureRollback(payload)) return finalizeStructureRollbackPayload(payload, result);
  const names = resultResourceNames(result);
  const pick = (indexes: unknown): string[] | null => {
    if (!Array.isArray(indexes)) return [];
    const out: string[] = [];
    for (const index of indexes) {
      const name = names[Number(index)];
      if (typeof name !== 'string' || !name) return null;
      out.push(name);
    }
    return out;
  };
  const unavailable = () => ({ ...payload, reversible: false, note: 'created_resources_unavailable' });
  const touched: string[] = Array.isArray(payload.touched_resources) ? [...payload.touched_resources] : [];

  if (payload.action_type === 'ext_restore_campaign_criteria') {
    const created = pick(payload.created_result_indexes);
    if (!created) return unavailable();
    return { ...payload, remove_criteria: created, touched_resources: [...new Set([...touched, ...created])] };
  }
  if (payload.action_type === 'ext_shared_list_rollback') {
    const groups = (payload.result_groups ?? {}) as Record<string, unknown>;
    const sets = pick(groups.shared_sets);
    const criteria = pick(groups.shared_criteria);
    const links = pick(groups.campaign_shared_sets);
    if (!sets || !criteria || !links) return unavailable();
    return {
      ...payload,
      remove_shared_sets: sets,
      remove_shared_criteria: criteria,
      remove_campaign_shared_sets: links,
      touched_resources: [...new Set([...touched, ...sets, ...criteria, ...links])],
    };
  }
  return payload;
}

export function isExtendedRollback(rollback: Record<string, any>): boolean {
  return typeof rollback?.action_type === 'string' && rollback.action_type.startsWith('ext_');
}

export function buildRollbackOperations(rollback: Record<string, any>): MutateOperation[] {
  if (isAdsStudioRollback(rollback)) return buildAdsStudioRollbackOperations(rollback);
  if (isValueRuleRollback(rollback)) return buildValueRuleRollbackOperations(rollback);
  if (isStructureRollback(rollback)) return buildStructureRollbackOperations(rollback);
  const touched = new Set<string>(Array.isArray(rollback.touched_resources) ? rollback.touched_resources : []);
  const guard = (name: unknown): string => {
    if (typeof name !== 'string' || !name || !touched.has(name)) {
      throw new Error('Rollback names a resource that is not part of the original change');
    }
    return name;
  };
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(guard) : []);

  switch (rollback.action_type) {
    case 'ext_restore_campaign_criteria': {
      const ops: MutateOperation[] = [];
      for (const name of list(rollback.remove_criteria)) ops.push(criterion({ remove: name }));
      for (const r of (rollback.restore_modifiers ?? []) as Array<{ resource_name: string; bid_modifier: number }>) {
        ops.push(
          criterion({
            update: { resource_name: guard(r.resource_name), bid_modifier: r.bid_modifier },
            update_mask: toFieldMask(['bid_modifier']),
          })
        );
      }
      for (const c of (rollback.recreate ?? []) as Array<Record<string, any>>) {
        guard(c.campaign);
        ops.push(
          criterion({
            create: { campaign: c.campaign, bid_modifier: c.bid_modifier, [c.kind]: c.spec },
          })
        );
      }
      return ops;
    }

    case 'ext_restore_campaign_fields': {
      const fields = (rollback.fields ?? {}) as Record<string, unknown>;
      const paths = Object.keys(fields);
      if (paths.length === 0) throw new Error('Nothing to restore');
      const update: Record<string, any> = { resource_name: guard(rollback.campaign_resource) };
      for (const path of paths) {
        const [group, leaf] = path.split('.');
        update[group] = { ...(update[group] ?? {}), [leaf]: fields[path] };
      }
      return [{ campaign_operation: { update, update_mask: toFieldMask(paths) } }];
    }

    case 'ext_shared_list_rollback': {
      // Detach first, then drop the keywords, then the list itself.
      const ops: MutateOperation[] = [];
      for (const name of list(rollback.remove_campaign_shared_sets)) ops.push({ campaign_shared_set_operation: { remove: name } });
      for (const name of list(rollback.remove_shared_criteria)) ops.push({ shared_criterion_operation: { remove: name } });
      for (const name of list(rollback.remove_shared_sets)) ops.push({ shared_set_operation: { remove: name } });
      return ops;
    }

    case 'ext_restore_subscriptions':
      return ((rollback.subscriptions ?? []) as Array<{ resource_name: string; status: string }>).map((s) => ({
        recommendation_subscription_operation: {
          update: { resource_name: guard(s.resource_name), status: s.status === 'PAUSED' ? 'PAUSED' : 'ENABLED' },
          update_mask: toFieldMask(['status']),
        },
      }));

    default:
      throw new Error('This action does not have a supported rollback operation');
  }
}

export async function executeExtendedRollback(
  rollback: Record<string, any>,
  customer: any,
  options?: { validateOnly?: boolean }
) {
  // No flag check: undoing an applied change must keep working after a flag goes off.
  const operations = buildRollbackOperations(rollback);
  if (operations.length === 0) throw new Error('Rollback produced no operations');
  return customer.mutateOperations(operations, options);
}
