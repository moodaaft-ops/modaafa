import { pickNum, pickStr } from '../growth/types';
import type { GeoRow } from './expansion';
type Reader = { query(sql: string): Promise<any[]> };
/** Actual user cities over 30 days, with full ancestry before suggesting any new target. */
export async function readExpansionGeo(customer: Reader) {
  const metrics = 'segments.geo_target_city, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value';
  let rows: any[];
  try { rows = await customer.query(`SELECT ${metrics} FROM geographic_view WHERE segments.date DURING LAST_30_DAYS AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'`); }
  catch { rows = await customer.query(`SELECT ${metrics} FROM user_location_view WHERE segments.date DURING LAST_30_DAYS`); }
  const targets = await customer.query(`SELECT campaign_criterion.location.geo_target_constant FROM campaign_criterion
    WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE AND campaign_criterion.status = 'ENABLED'`);
  const targeted = new Set(targets.map((r) => pickStr(r, 'campaign_criterion.location.geo_target_constant')).filter(Boolean));
  // With no explicit location the account already targets everywhere.
  if (!targeted.size) return null;
  const totals = new Map<string, GeoRow>();
  for (const r of rows) {
    const resource = pickStr(r, 'segments.geo_target_city');
    if (!/^geoTargetConstants\/\d+$/.test(resource)) continue;
    const v = totals.get(resource) ?? { resource, name: null, cost: 0, clicks: 0, conversions: 0, value: 0 };
    v.cost += (pickNum(r, 'metrics.cost_micros') ?? 0) / 1e6;
    v.clicks += pickNum(r, 'metrics.clicks') ?? 0; v.conversions += pickNum(r, 'metrics.conversions') ?? 0;
    v.value = (v.value ?? 0) + (pickNum(r, 'metrics.conversions_value') ?? 0); totals.set(resource, v);
  }
  const parents = new Map<string, string[]>();
  for (const v of [...totals.values()].filter((r) => r.conversions >= 2).sort((a,b) => b.conversions-a.conversions).slice(0, 20)) {
    const chain: string[] = []; let current = v.resource; let complete = false;
    for (let depth = 0; depth < 8; depth++) {
      const result = await customer.query(`SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.parent_geo_target, geo_target_constant.country_code
        FROM geo_target_constant WHERE geo_target_constant.resource_name = '${current}' LIMIT 1`);
      if (!result[0] || pickStr(result[0], 'geo_target_constant.country_code') !== 'SA') break;
      if (current === v.resource) v.name = pickStr(result[0], 'geo_target_constant.name');
      const parent = pickStr(result[0], 'geo_target_constant.parent_geo_target');
      if (!parent) { complete = true; break; }
      if (!/^geoTargetConstants\/\d+$/.test(parent) || chain.includes(parent)) break;
      chain.push(parent); current = parent;
    }
    if (complete) parents.set(v.resource, chain);
  }
  return { rows: [...totals.values()], parents, targeted };
}
