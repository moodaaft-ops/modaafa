/**
 * Reads the account's conversion value rules and sets. Read only. The GAQL
 * resources are conversion_value_rule and conversion_value_rule_set.
 *
 * `customer` is anything with query(gaql) (the Customer wrapper in
 * lib/google-ads/client.ts, or a fake in the tests). Field names are read in
 * both camelCase (REST) and snake_case.
 */
type Query = { query(gaql: string): Promise<any[]> };

export type ValueRuleView = {
  resource_name: string;
  operation: string;
  value: number;
  status: string;
  /** Which condition the rule uses, or none (a fallback rule). */
  condition: 'geo' | 'device' | 'audience' | 'itinerary' | 'none';
  geo_target_constants: string[];
  excluded_geo_target_constants: string[];
  geo_match_type: string;
  device_types: string[];
  user_lists: string[];
  user_interests: string[];
};

export type ValueRuleSetView = {
  resource_name: string;
  attachment_type: string;
  campaign: string | null;
  dimensions: string[];
  status: string;
  rule_resources: string[];
  rules: ValueRuleView[];
};

const RULES_QUERY = `
  SELECT conversion_value_rule.resource_name, conversion_value_rule.status,
    conversion_value_rule.action.operation, conversion_value_rule.action.value,
    conversion_value_rule.geo_location_condition.geo_target_constants,
    conversion_value_rule.geo_location_condition.geo_match_type,
    conversion_value_rule.geo_location_condition.excluded_geo_target_constants,
    conversion_value_rule.device_condition.device_types,
    conversion_value_rule.audience_condition.user_lists,
    conversion_value_rule.audience_condition.user_interests
  FROM conversion_value_rule
  WHERE conversion_value_rule.status != 'REMOVED'
`;

const SETS_QUERY = `
  SELECT conversion_value_rule_set.resource_name, conversion_value_rule_set.attachment_type,
    conversion_value_rule_set.campaign, conversion_value_rule_set.dimensions,
    conversion_value_rule_set.conversion_value_rules, conversion_value_rule_set.status
  FROM conversion_value_rule_set
  WHERE conversion_value_rule_set.status != 'REMOVED'
`;

function pickKey(object: any, camel: string, snake: string): any {
  if (!object || typeof object !== 'object') return undefined;
  return object[camel] !== undefined ? object[camel] : object[snake];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

export function parseRule(row: any): ValueRuleView | null {
  const rule = pickKey(row, 'conversionValueRule', 'conversion_value_rule');
  const resource = String(pickKey(rule, 'resourceName', 'resource_name') ?? '');
  if (!resource) return null;
  const action = rule.action ?? {};
  const geo = pickKey(rule, 'geoLocationCondition', 'geo_location_condition') ?? {};
  const device = pickKey(rule, 'deviceCondition', 'device_condition') ?? {};
  const audience = pickKey(rule, 'audienceCondition', 'audience_condition') ?? {};
  const geoTargets = strings(pickKey(geo, 'geoTargetConstants', 'geo_target_constants'));
  const excluded = strings(pickKey(geo, 'excludedGeoTargetConstants', 'excluded_geo_target_constants'));
  const devices = strings(pickKey(device, 'deviceTypes', 'device_types'));
  const lists = strings(pickKey(audience, 'userLists', 'user_lists'));
  const interests = strings(pickKey(audience, 'userInterests', 'user_interests'));
  const condition: ValueRuleView['condition'] =
    geoTargets.length > 0 || excluded.length > 0
      ? 'geo'
      : devices.length > 0
        ? 'device'
        : lists.length > 0 || interests.length > 0
          ? 'audience'
          : 'none';
  return {
    resource_name: resource,
    operation: String(action.operation ?? ''),
    value: Number(action.value ?? 0),
    status: String(rule.status ?? ''),
    condition,
    geo_target_constants: geoTargets,
    excluded_geo_target_constants: excluded,
    geo_match_type: String(pickKey(geo, 'geoMatchType', 'geo_match_type') ?? ''),
    device_types: devices,
    user_lists: lists,
    user_interests: interests,
  };
}

export function parseSet(row: any): Omit<ValueRuleSetView, 'rules'> | null {
  const set = pickKey(row, 'conversionValueRuleSet', 'conversion_value_rule_set');
  const resource = String(pickKey(set, 'resourceName', 'resource_name') ?? '');
  if (!resource) return null;
  const campaign = String(set.campaign ?? '');
  return {
    resource_name: resource,
    attachment_type: String(pickKey(set, 'attachmentType', 'attachment_type') ?? ''),
    campaign: campaign || null,
    dimensions: strings(set.dimensions),
    status: String(set.status ?? ''),
    rule_resources: strings(pickKey(set, 'conversionValueRules', 'conversion_value_rules')),
  };
}

export async function readValueRuleSets(customer: Query): Promise<ValueRuleSetView[]> {
  const [ruleRows, setRows] = await Promise.all([customer.query(RULES_QUERY), customer.query(SETS_QUERY)]);
  const rules = new Map<string, ValueRuleView>();
  for (const row of ruleRows ?? []) {
    const parsed = parseRule(row);
    if (parsed) rules.set(parsed.resource_name, parsed);
  }
  const out: ValueRuleSetView[] = [];
  for (const row of setRows ?? []) {
    const parsed = parseSet(row);
    if (!parsed) continue;
    out.push({ ...parsed, rules: parsed.rule_resources.map((name) => rules.get(name)).filter((r): r is ValueRuleView => Boolean(r)) });
  }
  return out;
}

export async function readValueRule(customer: Query, resource: string): Promise<ValueRuleView | null> {
  const rows = await customer.query(`${RULES_QUERY.replace("WHERE conversion_value_rule.status != 'REMOVED'", `WHERE conversion_value_rule.resource_name = '${resource.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)}`);
  for (const row of rows ?? []) {
    const parsed = parseRule(row);
    if (parsed && parsed.resource_name === resource) return parsed;
  }
  return null;
}

/** The set that already carries this attachment and dimension, if any (one set per slot keeps precedence unambiguous). */
export function findSetFor(
  sets: ValueRuleSetView[],
  slot: { attachment: 'customer' | 'campaign'; campaign_resource?: string | null; dimension: string }
): ValueRuleSetView | null {
  const type = slot.attachment === 'customer' ? 'CUSTOMER' : 'CAMPAIGN';
  return (
    sets.find(
      (set) =>
        set.status !== 'REMOVED' &&
        set.attachment_type === type &&
        (slot.attachment === 'customer' || set.campaign === slot.campaign_resource) &&
        set.dimensions[0] === slot.dimension
    ) ?? null
  );
}

/** The set that holds a rule. */
export function setOfRule(sets: ValueRuleSetView[], rule: string): ValueRuleSetView | null {
  return sets.find((set) => set.rule_resources.includes(rule)) ?? null;
}
