/**
 * Conversion value rules (GAP-144 item 8). They tell Smart Bidding that a
 * conversion from some place, device or audience is worth more or less than
 * the value recorded, so tROAS / Maximize conversion value learn on the real
 * worth of a customer (titan tracking.md section 3: a city that brings
 * higher value customers).
 *
 * The two approval actions ride on the extended-actions pipeline, so they need
 * EXTENDED_ACTIONS_ENABLED=true and nothing else: validation, live preflight,
 * guardrails, validateOnly, one atomic googleAds:mutate, rollback record and
 * readback are the existing ones (lib/ai/extended-actions).
 *
 * Resource and field names (Google Ads API v22): ConversionValueRule{action
 * {operation,value}, geo_location_condition{geo_target_constants,geo_match_type,
 * excluded_*}, device_condition{device_types}, audience_condition{user_lists,
 * user_interests}, status}, ConversionValueRuleSet{conversion_value_rules,
 * dimensions, attachment_type, campaign, status}; mutate operations
 * conversion_value_rule_operation and conversion_value_rule_set_operation.
 * Documented limits: MULTIPLY value 0.5 to 10, a rule belongs to ONE set, a set
 * keeps at least one enabled or paused rule, a rule referenced by a set cannot
 * be removed, campaign-level sets take priority over customer-level ones.
 */

export const VALUE_RULE_OPERATIONS = ['create_value_rule_set', 'update_value_rule'] as const;
export type ValueRuleOperation = (typeof VALUE_RULE_OPERATIONS)[number];

const SET: ReadonlySet<string> = new Set(VALUE_RULE_OPERATIONS);

export function isValueRuleOperation(value: unknown): value is ValueRuleOperation {
  return typeof value === 'string' && SET.has(value);
}

/** Rollback payloads of these actions carry this action_type prefix (they also start with ext_). */
export const VALUE_RULE_ROLLBACK_PREFIX = 'ext_vr_';

export function isValueRuleRollback(rollback: unknown): boolean {
  const type = (rollback as { action_type?: unknown } | null | undefined)?.action_type;
  return typeof type === 'string' && type.startsWith(VALUE_RULE_ROLLBACK_PREFIX);
}

/**
 * Google accepts 0.5 to 10 for MULTIPLY. The platform stays between 0.5 and 2
 * and never sends 1 (no change): one approval can halve or double the worth of
 * a slice of conversions, not more. ADD and SET are not offered (SET needs an
 * allowlisted account).
 */
export const VALUE_MULTIPLIER_MIN = 0.5;
export const VALUE_MULTIPLIER_MAX = 2;
export const MAX_RULES_PER_SET = 5;
export const MAX_GEO_PER_RULE = 20;
export const MAX_AUDIENCES_PER_RULE = 10;

/** One dimension per set keeps the card readable and the precedence rules simple. */
export const VALUE_RULE_DIMENSIONS = ['GEO_LOCATION', 'DEVICE', 'AUDIENCE'] as const;
export type ValueRuleDimension = (typeof VALUE_RULE_DIMENSIONS)[number];

export const VALUE_RULE_DEVICES = ['MOBILE', 'DESKTOP', 'TABLET'] as const;
export const VALUE_RULE_GEO_MATCH = ['PRESENCE', 'PRESENCE_OR_INTEREST'] as const;
export const VALUE_RULE_STATUSES = ['ENABLED', 'PAUSED'] as const;

/** Bidding strategies that read conversion value; a rule changes nothing for any other. */
export const VALUE_BIDDING_STRATEGIES: ReadonlySet<string> = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']);
