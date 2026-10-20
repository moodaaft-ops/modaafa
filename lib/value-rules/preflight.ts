import type { OptimizerAction } from '@/lib/ai/optimizer-agent';
import { readCampaignState } from '@/lib/ai/extended-actions/preflight';
import { findSetFor, readValueRule, readValueRuleSets } from './reader';
import { VALUE_BIDDING_STRATEGIES, type ValueRuleOperation } from './types';
import type { CleanRule } from './validate';

/**
 * Pre-execution reads for the value rule actions. Everything the live mutate
 * needs is read from the account HERE and stored in `params.resolved`; the
 * executor sends exactly that. A stored payload never carries `resolved`
 * (validateValueRulePayload builds params from a whitelist).
 */
export class ValueRulePreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ValueRulePreflightError';
  }
}

const refuse = (code: string, message: string): never => {
  throw new ValueRulePreflightError(code, message);
};

export type ValueRulePrepared = {
  action: OptimizerAction;
  rollbackPayload: Record<string, unknown>;
  measurement: null;
};

function withResolved(action: OptimizerAction, resolved: Record<string, unknown>): OptimizerAction {
  return { ...action, params: { ...action.params, resolved } };
}

function customerIdOf(customer: any, fallbackResource?: string): string {
  const fromCustomer = String(customer?.credentials?.customer_id ?? '').replace(/\D/g, '');
  if (fromCustomer) return fromCustomer;
  const match = /^customers\/(\d+)\//.exec(fallbackResource ?? '');
  if (match) return match[1];
  return refuse('customer_unknown', 'Customer id is unavailable for a mutate that needs temporary resource names');
}

function esc(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}


/** The condition part of one rule, in the wire shape of the mutate. */
export function ruleCondition(dimension: string, rule: CleanRule): Record<string, unknown> {
  if (dimension === 'GEO_LOCATION') {
    return { geo_location_condition: { geo_target_constants: rule.geo_target_constants, geo_match_type: rule.geo_match_type ?? 'PRESENCE' } };
  }
  if (dimension === 'DEVICE') return { device_condition: { device_types: rule.device_types } };
  return { audience_condition: { user_lists: rule.user_lists } };
}

/**
 * A rule set only changes what Smart Bidding sees when at least one campaign
 * it covers bids on conversion value.
 */
async function requireValueBidding(customer: any, attachment: 'customer' | 'campaign', campaignResource: string | null) {
  if (attachment === 'campaign') {
    const state = await readCampaignState(customer, campaignResource!);
    if (state.status === 'REMOVED') return refuse('campaign_removed', 'Campaign is removed');
    if (!VALUE_BIDDING_STRATEGIES.has(state.bidding)) {
      return refuse('no_value_bidding', `${state.bidding || 'This campaign'} does not bid on conversion value, so a value rule would change nothing`);
    }
    return;
  }
  const rows = await customer.query(`
    SELECT campaign.resource_name, campaign.bidding_strategy_type
    FROM campaign
    WHERE campaign.status = 'ENABLED'
  `);
  const anyValue = (rows ?? []).some((row: any) => {
    const campaign = row?.campaign ?? {};
    return VALUE_BIDDING_STRATEGIES.has(String(campaign.biddingStrategyType ?? campaign.bidding_strategy_type ?? ''));
  });
  if (!anyValue) refuse('no_value_bidding', 'No enabled campaign bids on conversion value, so a value rule would change nothing');
}

async function requireUserLists(customer: any, lists: string[]) {
  if (lists.length === 0) return;
  const quoted = lists.map((name) => `'${esc(name)}'`).join(', ');
  const rows = await customer.query(`
    SELECT user_list.resource_name
    FROM user_list
    WHERE user_list.resource_name IN (${quoted})
  `);
  const found = new Set((rows ?? []).map((row: any) => String((row?.userList ?? row?.user_list)?.resourceName ?? (row?.userList ?? row?.user_list)?.resource_name ?? '')));
  if (lists.some((name) => !found.has(name))) refuse('user_list_not_found', 'An audience of the rule does not exist in the account');
}

async function prepareCreate(action: OptimizerAction, customer: any): Promise<ValueRulePrepared> {
  const params = action.params as Record<string, any>;
  const attachment = params.attachment as 'customer' | 'campaign';
  const campaign = attachment === 'campaign' ? String(params.campaign_resource) : null;
  const dimension = String(params.dimension);
  const rules = params.rules as CleanRule[];
  const cid = customerIdOf(customer, campaign ?? undefined);

  const sets = await readValueRuleSets(customer);
  const existing = findSetFor(sets, { attachment, campaign_resource: campaign, dimension });
  if (existing) return refuse('rule_set_exists', 'A value rule set already covers this scope and dimension; edit its rules instead');

  await requireValueBidding(customer, attachment, campaign);
  if (dimension === 'AUDIENCE') await requireUserLists(customer, rules.flatMap((rule) => rule.user_lists ?? []));

  const resolved = {
    customer_id: cid,
    attachment_type: attachment === 'customer' ? 'CUSTOMER' : 'CAMPAIGN',
    campaign,
    dimension,
    set_temp: `customers/${cid}/conversionValueRuleSets/-${rules.length + 1}`,
    rules: rules.map((rule, index) => ({
      temp: `customers/${cid}/conversionValueRules/-${index + 1}`,
      label: rule.label,
      multiplier: rule.multiplier,
      condition: ruleCondition(dimension, rule),
    })),
  };
  // Operation order is [rule create x n, set create]: the rules are results 0..n-1.
  return {
    action: withResolved(action, resolved),
    rollbackPayload: {
      reversible: true,
      action_type: 'ext_vr_pause_rules',
      // The created rules are paused, not removed: Google refuses to remove a rule a set still references.
      pause_rules: [],
      created_rule_indexes: rules.map((_, index) => index),
      touched_resources: campaign ? [campaign] : [],
    },
    measurement: null,
  };
}

async function prepareUpdate(action: OptimizerAction, customer: any): Promise<ValueRulePrepared> {
  const params = action.params as Record<string, any>;
  const resource = String(params.rule_resource);
  const rule = await readValueRule(customer, resource);
  if (!rule) return refuse('rule_not_found', 'The value rule could not be read');
  if (rule.status === 'REMOVED') return refuse('rule_removed', 'The value rule is removed');
  if (rule.operation !== 'MULTIPLY') return refuse('rule_not_multiply', 'Only a MULTIPLY rule is edited from here');

  const newValue = params.multiplier === undefined ? rule.value : Number(params.multiplier);
  const newStatus = params.status === undefined ? rule.status : String(params.status);
  if (Math.round(newValue * 100) === Math.round(rule.value * 100) && newStatus === rule.status) {
    return refuse('no_change', 'The rule already has these values');
  }
  const sets = await readValueRuleSets(customer);
  const holder = sets.find((set) => set.rule_resources.includes(resource));
  if (!holder) return refuse('rule_not_in_set', 'The rule is not part of a set');
  if (params.multiplier !== undefined && newStatus !== 'PAUSED') {
    if (holder.attachment_type === 'CAMPAIGN' && holder.campaign) await requireValueBidding(customer, 'campaign', holder.campaign);
    if (holder.attachment_type === 'CUSTOMER') await requireValueBidding(customer, 'customer', null);
  }

  const resolved = {
    rule: resource,
    set: holder.resource_name,
    previous_multiplier: Math.round(rule.value * 100) / 100,
    previous_status: rule.status,
    new_multiplier: Math.round(newValue * 100) / 100,
    new_status: newStatus,
    changes_value: params.multiplier !== undefined && Math.round(newValue * 100) !== Math.round(rule.value * 100),
    changes_status: newStatus !== rule.status,
  };
  return {
    action: withResolved(action, resolved),
    rollbackPayload: {
      reversible: true,
      action_type: 'ext_vr_restore_rule',
      resource_name: resource,
      previous_multiplier: resolved.previous_multiplier,
      previous_status: resolved.previous_status,
      changes_value: resolved.changes_value,
      changes_status: resolved.changes_status,
      touched_resources: [resource],
    },
    measurement: null,
  };
}

export async function prepareValueRuleAction(action: OptimizerAction, customer: any): Promise<ValueRulePrepared> {
  const operation = action.type as ValueRuleOperation;
  return operation === 'create_value_rule_set' ? prepareCreate(action, customer) : prepareUpdate(action, customer);
}

