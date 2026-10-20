import { toFieldMask } from '@/lib/google-ads/client';
import type { OptimizerAction } from '@/lib/ai/optimizer-agent';
import type { ValueRuleOperation } from './types';

/**
 * Builds the googleAds:mutate operations for the value rule actions from the
 * `params.resolved` block that preflight wrote, and the matching rollback.
 * validateOnly and the live call send the SAME operations. Operations are
 * written in snake_case; the REST wrapper camelizes the keys.
 *
 * A create is ONE atomic request: the rules (temporary resource names) first,
 * then the set that holds them. Undoing a create PAUSES the created rules
 * instead of removing them: Google refuses to remove a rule that a set still
 * references and a set must keep one enabled or paused rule, so a pause is the
 * undo that cannot be refused. A paused rule has no effect on bidding.
 */
export type ValueRuleMutateOperation = Record<string, Record<string, unknown>>;

function resolvedOf(action: OptimizerAction): Record<string, any> {
  const resolved = (action.params as Record<string, unknown>).resolved;
  if (!resolved || typeof resolved !== 'object') {
    throw new Error('Value rule action was not prepared: run prepareActionForExecution first');
  }
  return resolved as Record<string, any>;
}

export function buildValueRuleOperations(action: OptimizerAction): ValueRuleMutateOperation[] {
  const resolved = resolvedOf(action);

  switch (action.type as ValueRuleOperation) {
    case 'create_value_rule_set': {
      const ops: ValueRuleMutateOperation[] = [];
      for (const rule of resolved.rules as Array<{ temp: string; multiplier: number; condition: Record<string, unknown> }>) {
        ops.push({
          conversion_value_rule_operation: {
            create: {
              resource_name: rule.temp,
              action: { operation: 'MULTIPLY', value: rule.multiplier },
              status: 'ENABLED',
              ...rule.condition,
            },
          },
        });
      }
      const set: Record<string, unknown> = {
        resource_name: resolved.set_temp,
        conversion_value_rules: (resolved.rules as Array<{ temp: string }>).map((rule) => rule.temp),
        dimensions: [resolved.dimension],
        attachment_type: resolved.attachment_type,
      };
      if (resolved.attachment_type === 'CAMPAIGN') set.campaign = resolved.campaign;
      ops.push({ conversion_value_rule_set_operation: { create: set } });
      return ops;
    }

    case 'update_value_rule': {
      const update: Record<string, unknown> = { resource_name: resolved.rule };
      const paths: string[] = [];
      if (resolved.changes_value) {
        update.action = { operation: 'MULTIPLY', value: resolved.new_multiplier };
        paths.push('action.operation', 'action.value');
      }
      if (resolved.changes_status) {
        update.status = resolved.new_status;
        paths.push('status');
      }
      if (paths.length === 0) throw new Error('Value rule update has nothing to change');
      return [{ conversion_value_rule_operation: { update, update_mask: toFieldMask(paths) } }];
    }

    default:
      throw new Error(`No mutate operations for ${action.type}`);
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

function resultNames(result: any): string[] {
  const results: any[] = Array.isArray(result?.results) ? result.results : [];
  return results
    .map((entry) => entry?.resourceName ?? entry?.resource_name)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Turns the result indexes recorded at preflight into the rule names Google created. */
export function finalizeValueRuleRollback(payload: Record<string, any>, result: unknown): Record<string, unknown> {
  if (payload.action_type !== 'ext_vr_pause_rules') return payload;
  const names = resultNames(result);
  const indexes: unknown[] = Array.isArray(payload.created_rule_indexes) ? payload.created_rule_indexes : [];
  const created: string[] = [];
  for (const index of indexes) {
    const name = names[Number(index)];
    if (typeof name !== 'string' || !name) return { ...payload, reversible: false, note: 'created_resources_unavailable' };
    created.push(name);
  }
  const touched: string[] = Array.isArray(payload.touched_resources) ? payload.touched_resources : [];
  return { ...payload, pause_rules: created, touched_resources: [...new Set([...touched, ...created])] };
}

export function buildValueRuleRollbackOperations(rollback: Record<string, any>): ValueRuleMutateOperation[] {
  const touched = new Set<string>(Array.isArray(rollback.touched_resources) ? rollback.touched_resources : []);
  const guard = (name: unknown): string => {
    if (typeof name !== 'string' || !name || !touched.has(name)) {
      throw new Error('Rollback names a resource that is not part of the original change');
    }
    return name;
  };

  switch (rollback.action_type) {
    case 'ext_vr_pause_rules': {
      const names: unknown[] = Array.isArray(rollback.pause_rules) ? rollback.pause_rules : [];
      return names.map((name) => ({
        conversion_value_rule_operation: {
          update: { resource_name: guard(name), status: 'PAUSED' },
          update_mask: toFieldMask(['status']),
        },
      }));
    }
    case 'ext_vr_restore_rule': {
      const update: Record<string, unknown> = { resource_name: guard(rollback.resource_name) };
      const paths: string[] = [];
      if (rollback.changes_value === true) {
        const value = Number(rollback.previous_multiplier);
        if (!(value > 0)) throw new Error('Rollback has no previous multiplier');
        update.action = { operation: 'MULTIPLY', value };
        paths.push('action.operation', 'action.value');
      }
      if (rollback.changes_status === true) {
        update.status = rollback.previous_status === 'PAUSED' ? 'PAUSED' : 'ENABLED';
        paths.push('status');
      }
      if (paths.length === 0) throw new Error('Nothing to restore');
      return [{ conversion_value_rule_operation: { update, update_mask: toFieldMask(paths) } }];
    }
    default:
      throw new Error('This action does not have a supported rollback operation');
  }
}

