import type { ProvisioningContext } from '@/lib/google-ads/provisioning';
import { refreshIfStale, startProvision } from './service';
import type { ProvisionStore } from './store';
import { provisionView, type ProvisionRow, type ProvisionView } from './types';

/**
 * The gates of POST and GET /api/ads-account/provision, with every dependency
 * injected so each gate is tested without Supabase or Google
 * (tests/provisioning-handler.test.ts). The route file only wires the real ones.
 */

export type HandlerResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type ProvisionPostDeps = {
  isSameOrigin: () => boolean;
  getUser: () => Promise<{ id: string; email: string | null } | null>;
  /** The flag is on for this email AND a manager id is configured. */
  isEnabledFor: (email: string | null) => boolean;
  /** Throws when the limiter store is down. */
  rateLimit: (userId: string) => Promise<{ allowed: boolean; headers?: Record<string, string> }>;
  /** Throws on a read failure: the gate fails CLOSED, creating an account spends a manager slot. */
  isRegistered: (userId: string) => Promise<boolean>;
  /** Null when the manager account or its token is not set up. */
  loadAds: () => Promise<ProvisioningContext | null>;
  store: ProvisionStore;
  unlinkAfterAccept: boolean;
  readBody: () => Promise<{ email?: unknown } | null>;
};

export async function handleProvisionPost(deps: ProvisionPostDeps): Promise<HandlerResult> {
  if (!deps.isSameOrigin()) return { status: 403, body: { ok: false, error: 'invalid_origin' } };

  const user = await deps.getUser();
  if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  if (!deps.isEnabledFor(user.email)) return { status: 404, body: { ok: false, error: 'not_available' } };

  try {
    const limit = await deps.rateLimit(user.id);
    if (!limit.allowed) return { status: 429, body: { ok: false, error: 'too_many_requests' }, headers: limit.headers };
  } catch {
    return { status: 503, body: { ok: false, error: 'security_service_unavailable' } };
  }

  try {
    if (!(await deps.isRegistered(user.id))) return { status: 403, body: { ok: false, error: 'registration_incomplete' } };

    const ads = await deps.loadAds();
    if (!ads) return { status: 503, body: { ok: false, error: 'not_configured' } };

    const body = await deps.readBody();
    const result = await startProvision({ store: deps.store, ads, unlinkAfterAccept: deps.unlinkAfterAccept }, user, body?.email);
    if (!result.ok) return { status: 400, body: { ok: false, error: 'invalid_email' } };
    return { status: 200, body: { ok: true, provision: provisionView(result.row) } };
  } catch (error) {
    console.error('ads account provisioning failed', error instanceof Error ? error.message : 'unknown');
    return { status: 500, body: { ok: false, error: 'provision_failed' } };
  }
}

export type ProvisionGetDeps = {
  getUser: () => Promise<{ id: string; email: string | null } | null>;
  /** The flag/manager/token check and the user's row, failing closed (lib/provisioning/load.ts). */
  loadState: (user: { id: string; email: string | null }) => Promise<{ available: boolean; row: ProvisionRow | null }>;
  loadAds: () => Promise<ProvisioningContext | null>;
  store: ProvisionStore;
  unlinkAfterAccept: boolean;
};

export async function handleProvisionGet(deps: ProvisionGetDeps): Promise<HandlerResult> {
  const user = await deps.getUser();
  if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  const state = await deps.loadState(user);
  if (!state.available) return { status: 200, body: { ok: true, available: false, provision: null } };
  if (!state.row) return { status: 200, body: { ok: true, available: true, provision: null } };

  let row = state.row;
  if (row.status === 'invited' || row.status === 'accepted') {
    try {
      const ads = await deps.loadAds();
      if (ads) row = await refreshIfStale({ store: deps.store, ads, unlinkAfterAccept: deps.unlinkAfterAccept }, row);
    } catch (error) {
      // The stored state is still true; the next poll or the hourly job looks again.
      console.warn('provision status refresh failed', error instanceof Error ? error.message : 'unknown');
    }
  }
  const view: ProvisionView = provisionView(row);
  return { status: 200, body: { ok: true, available: true, provision: view } };
}
