import { randomBytes } from 'node:crypto';
import { FEATURE_SCOPE, isExtraFeature, type ExtraFeature } from './features';

/**
 * State and result handling of the separate consent. Pure: the route files
 * persist the state (oauth_states, single use, bound to the signed-in user)
 * and call these.
 */

const STATE_PATTERN = /^(data_manager|ga4|gbp)~([0-9a-f]{48})$/;

/** `<feature>~<192 bits of randomness>`. The feature is only a routing hint: the stored state row is what is trusted. */
export function newExtraState(feature: ExtraFeature, random: () => Buffer = () => randomBytes(24)): string {
  return `${feature}~${random().toString('hex')}`;
}

export function parseExtraState(state: unknown): { feature: ExtraFeature } | null {
  if (typeof state !== 'string') return null;
  const match = STATE_PATTERN.exec(state);
  if (!match || !isExtraFeature(match[1])) return null;
  return { feature: match[1] };
}

/** Google returns the granted scopes space separated. The user can untick a box on the consent screen. */
export function grantedScopes(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
}

export type GrantVerdict =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: 'missing_scope' | 'extra_scope' | 'no_refresh_token' };

/**
 * The grant must carry exactly the scope of this feature. A narrower grant
 * (box unticked) is refused as `missing_scope`. A broader one (the consent
 * merged other scopes, which `include_granted_scopes` would do) is refused as
 * `extra_scope`: a stored token must never carry more than the feature needs.
 */
export function evaluateGrant(feature: ExtraFeature, tokens: { scope?: unknown; refresh_token?: unknown }): GrantVerdict {
  const scopes = grantedScopes(tokens.scope);
  const wanted = FEATURE_SCOPE[feature];
  if (!scopes.includes(wanted)) return { ok: false, reason: 'missing_scope' };
  const extra = scopes.filter((scope) => scope !== wanted && !isHarmlessIdentityScope(scope));
  if (extra.length > 0) return { ok: false, reason: 'extra_scope' };
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) return { ok: false, reason: 'no_refresh_token' };
  return { ok: true, scopes: [wanted] };
}

function isHarmlessIdentityScope(scope: string): boolean {
  return scope === 'openid' || scope === 'email' || scope === 'profile' || scope.startsWith('https://www.googleapis.com/auth/userinfo.');
}

/** Where the callback sends the merchant, by outcome. Arabic copy lives in the page that reads `?extra=`. */
export function callbackRedirect(feature: ExtraFeature | null, outcome: string): string {
  const base = '/settings';
  const params = new URLSearchParams({ extra: outcome });
  if (feature) params.set('feature', feature);
  return `${base}?${params.toString()}`;
}
