import { resolveRegionConstants, type SuggestRequest } from './geo';
const TTL = 24 * 60 * 60 * 1000;
const cache = new Map<string, { resource: string; until: number }>();
/** Geo constants are public. Only successful lookups are cached, bounded per process. */
export async function cachedRegionConstants(names: string[], request: SuggestRequest, now = Date.now()) {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 10);
  const out: Record<string, string> = {};
  const missing = unique.filter((name) => {
    const hit = cache.get(name);
    if (hit && hit.until > now) { out[name] = hit.resource; return false; }
    return true;
  });
  if (missing.length) {
    const resolved = await resolveRegionConstants(missing, request);
    for (const [name, resource] of Object.entries(resolved)) {
      if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
      cache.set(name, { resource, until: now + TTL }); out[name] = resource;
    }
  }
  return out;
}
