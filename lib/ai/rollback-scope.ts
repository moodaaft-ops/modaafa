/**
 * Every resource named in a rollback payload must live under the SELECTED
 * account's customer id. Defence in depth: `ai_actions` writes are
 * service-role only, but if a crafted `rollback_payload` ever reached the
 * rollback route it would otherwise be executed verbatim as a live Google Ads
 * mutation against whatever `customers/<id>/…` it named.
 *
 * Batch payloads carry a `resource_names` list: EVERY entry is checked, and a
 * list that is present but malformed (not an array, empty, or holding a
 * non-string) fails closed.
 */
export function rollbackResourcesScoped(rollback: Record<string, any>, customerId: string): boolean {
  const cid = String(customerId ?? '').replace(/\D/g, '');
  if (!cid) return false;
  const prefix = `customers/${cid}/`;

  // Extended (ext_*) payloads carry more than one resource list. Every one is
  // checked and a malformed list fails closed. Without the flag these never exist.
  if (typeof rollback.action_type === 'string' && rollback.action_type.startsWith('ext_')) {
    return extendedRollbackScoped(rollback, prefix);
  }

  const resources: string[] = [];
  for (const key of ['budget_resource', 'resource_name', 'ad_group_resource', 'campaign_resource']) {
    const value = rollback[key];
    if (typeof value === 'string' && value.length > 0) resources.push(value);
  }
  if (rollback.resource_names !== undefined) {
    const list = rollback.resource_names;
    if (!Array.isArray(list) || list.length === 0) return false;
    for (const value of list) {
      if (typeof value !== 'string' || value.length === 0) return false;
      resources.push(value);
    }
  }

  if (resources.length === 0) return false;
  return resources.every((value) => value.startsWith(prefix));
}

const EXTENDED_NAME_LISTS = [
  'touched_resources',
  'remove_criteria',
  'remove_shared_sets',
  'remove_shared_criteria',
  'remove_campaign_shared_sets',
  // Ad copy and assets (ADS_STUDIO_ENABLED)
  'pause_ads',
  'reenable_ads',
  'remove_campaign_assets',
  // Conversion value rules
  'pause_rules',
  // Account structure (steps' resource names)
  'struct_names',
];

function extendedRollbackScoped(rollback: Record<string, any>, prefix: string): boolean {
  const names: unknown[] = [];
  const touched = rollback.touched_resources;
  if (!Array.isArray(touched) || touched.length === 0) return false;

  for (const key of EXTENDED_NAME_LISTS) {
    if (rollback[key] === undefined) continue;
    if (!Array.isArray(rollback[key])) return false;
    names.push(...rollback[key]);
  }
  for (const key of ['budget_resource', 'resource_name', 'campaign_resource']) {
    if (rollback[key] !== undefined) names.push(rollback[key]);
  }
  for (const key of ['restore_modifiers', 'subscriptions']) {
    if (rollback[key] === undefined) continue;
    if (!Array.isArray(rollback[key])) return false;
    for (const entry of rollback[key]) names.push(entry?.resource_name);
  }
  if (rollback.recreate !== undefined) {
    if (!Array.isArray(rollback.recreate)) return false;
    for (const entry of rollback.recreate) names.push(entry?.campaign);
  }

  return names.every((value) => typeof value === 'string' && value.startsWith(prefix));
}
