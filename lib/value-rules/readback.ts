import type { OptimizerAction } from '@/lib/ai/optimizer-agent';
import { findSetFor, readValueRule, readValueRuleSets } from './reader';

/**
 * Reads the account back after a live mutate and says whether the value rules
 * are there. Never throws and never undoes anything (same contract as
 * lib/ai/extended-actions/readback.ts, which calls this for these operations).
 */
export type ValueRuleReadback = { status: 'verified' | 'mismatch' | 'unavailable'; detail?: string };

const ok = (): ValueRuleReadback => ({ status: 'verified' });
const mismatch = (detail: string): ValueRuleReadback => ({ status: 'mismatch', detail });
const near = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

export async function readbackValueRuleAction(action: OptimizerAction, customer: any): Promise<ValueRuleReadback> {
  try {
    const params = action.params as Record<string, any>;
    const resolved = (params.resolved ?? {}) as Record<string, any>;

    if (action.type === 'create_value_rule_set') {
      const sets = await readValueRuleSets(customer);
      const set = findSetFor(sets, {
        attachment: params.attachment,
        campaign_resource: resolved.campaign ?? null,
        dimension: String(params.dimension),
      });
      if (!set) return mismatch('rule set not found');
      const wanted: number[] = (resolved.rules ?? []).map((r: any) => Number(r.multiplier));
      if (set.rules.length !== wanted.length) return mismatch('rule count differs');
      for (const value of wanted) {
        if (!set.rules.some((rule) => rule.operation === 'MULTIPLY' && near(rule.value, value))) return mismatch(`multiplier ${value} missing`);
      }
      return ok();
    }

    if (action.type === 'update_value_rule') {
      const rule = await readValueRule(customer, String(params.rule_resource));
      if (!rule) return mismatch('rule not found');
      if (resolved.changes_value && !near(rule.value, Number(resolved.new_multiplier))) return mismatch('multiplier not updated');
      if (resolved.changes_status && rule.status !== resolved.new_status) return mismatch('status not updated');
      return ok();
    }
    return { status: 'unavailable', detail: 'no_readback_for_type' };
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message.slice(0, 200) : 'read_failed' };
  }
}
