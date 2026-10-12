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
