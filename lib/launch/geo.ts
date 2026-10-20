import { normalizeArabicKey } from './arabic';

/**
 * Region names to geo target constants through GeoTargetConstantService.suggest
 * (REST: POST /geoTargetConstants:suggest). Pure parser plus a thin caller; the
 * caller is injected so tests never reach the network. Not verified live
 * (see docs/mb-upgrade/launch.md): a name this cannot resolve becomes a blocker
 * on the plan, never a silent fall back to the whole country.
 */

export type SuggestRequest = (body: Record<string, unknown>) => Promise<any>;

type Suggestion = {
  searchTerm?: string;
  search_term?: string;
  geoTargetConstant?: Record<string, any>;
  geo_target_constant?: Record<string, any>;
};

const PREFERRED_TYPES = ['city', 'governorate', 'region', 'province', 'neighborhood', 'district', 'state'];

export function pickGeoTargetConstants(names: string[], response: any): Record<string, string> {
  const list: Suggestion[] = response?.geoTargetConstantSuggestions ?? response?.geo_target_constant_suggestions ?? [];
  const out: Record<string, string> = {};
  for (const name of names) {
    const key = normalizeArabicKey(name);
    const candidates = list
      .map((entry) => ({
        term: normalizeArabicKey(String(entry.searchTerm ?? entry.search_term ?? '')),
        constant: (entry.geoTargetConstant ?? entry.geo_target_constant ?? {}) as Record<string, any>,
      }))
      .filter(({ term, constant }) => {
        const country = String(constant.countryCode ?? constant.country_code ?? '').toUpperCase();
        const status = String(constant.status ?? 'ENABLED').toUpperCase();
        const resource = String(constant.resourceName ?? constant.resource_name ?? '');
        return term === key && country === 'SA' && status === 'ENABLED' && /^geoTargetConstants\/\d+$/.test(resource);
      });
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => rank(a.constant) - rank(b.constant));
    out[name] = String(candidates[0].constant.resourceName ?? candidates[0].constant.resource_name);
  }
  return out;
}

function rank(constant: Record<string, any>) {
  const type = String(constant.targetType ?? constant.target_type ?? '').toLowerCase();
  const index = PREFERRED_TYPES.indexOf(type);
  return index === -1 ? PREFERRED_TYPES.length : index;
}

export async function resolveRegionConstants(names: string[], request: SuggestRequest): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const response = await request({
    locale: 'ar',
    countryCode: 'SA',
    locationNames: { names },
  });
  return pickGeoTargetConstants(names, response);
}
