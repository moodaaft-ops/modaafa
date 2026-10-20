import type { StorePlatform } from './orders';

/**
 * Who the merchant is on the platform, read right after the code exchange.
 * Endpoints and field paths are from the public docs and NOT verified live:
 *  Salla: GET https://api.salla.dev/admin/v2/oauth2/user/info -> data.merchant.id
 *  Zid:   GET https://api.zid.sa/v1/managers/account/profile  -> user.store.id (Bearer = authorization JWT, X-Manager-Token = access_token)
 * Both URLs can be overridden by env. An unreadable answer yields null and the connect is refused, never guessed.
 */
function pickId(root: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let cur: unknown = root;
    for (const key of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    if (typeof cur === 'string' && cur.trim()) return cur.trim();
    if (typeof cur === 'number' && Number.isFinite(cur)) return String(cur);
  }
  return null;
}

export function parseStoreId(platform: StorePlatform, json: unknown): string | null {
  return platform === 'salla'
    ? pickId(json, [['data', 'merchant', 'id'], ['merchant', 'id']])
    : pickId(json, [['user', 'store', 'id'], ['store', 'id'], ['data', 'store', 'id']]);
}

export async function fetchStoreId(
  platform: StorePlatform,
  tokens: { access_token?: string; authorization?: string },
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env
): Promise<string | null> {
  if (!tokens.access_token) return null;
  const url =
    platform === 'salla'
      ? env.SALLA_PROFILE_URL || 'https://api.salla.dev/admin/v2/oauth2/user/info'
      : env.ZID_PROFILE_URL || 'https://api.zid.sa/v1/managers/account/profile';
  const headers: Record<string, string> =
    platform === 'salla'
      ? { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }
      : {
          Authorization: `Bearer ${tokens.authorization ?? ''}`,
          'X-Manager-Token': tokens.access_token,
          Accept: 'application/json',
          'Accept-Language': 'ar',
        };
  const res = await fetchImpl(url, { headers });
  if (!res.ok) return null;
  return parseStoreId(platform, await res.json());
}
