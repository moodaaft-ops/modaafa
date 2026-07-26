const MAX_PENDING_STATES = 8;

export const GOOGLE_ADS_OAUTH_STATE_COOKIE = 'gads_oauth_state';

export function encodeGoogleAdsOAuthStates(states: string[]) {
  const uniqueStates = states
    .map((state) => state.trim())
    .filter(Boolean)
    .filter((state, index, values) => values.indexOf(state) === index)
    .slice(0, MAX_PENDING_STATES);

  return Buffer.from(JSON.stringify(uniqueStates), 'utf8').toString('base64url');
}

export function readGoogleAdsOAuthStates(value?: string | null) {
  const rawValue = value?.trim();
  if (!rawValue) return [];

  if (isLikelyLegacyState(rawValue)) return [rawValue];

  try {
    const decoded = Buffer.from(rawValue, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    return normalizeStates(parsed);
  } catch {
    return [];
  }
}

export function appendGoogleAdsOAuthState(existingValue: string | undefined, nextState: string) {
  return encodeGoogleAdsOAuthStates([
    nextState,
    ...readGoogleAdsOAuthStates(existingValue).filter((state) => state !== nextState),
  ]);
}

export function hasGoogleAdsOAuthState(existingValue: string | undefined, returnedState: string) {
  return readGoogleAdsOAuthStates(existingValue).includes(returnedState);
}

export function removeGoogleAdsOAuthState(existingValue: string | undefined, usedState: string) {
  return encodeGoogleAdsOAuthStates(
    readGoogleAdsOAuthStates(existingValue).filter((state) => state !== usedState)
  );
}

/**
 * Generic aliases. The multi-state cookie is not Google-Ads specific — the
 * platform login flow needs exactly the same behaviour, because a
 * single-slot state cookie is overwritten whenever the user opens the login
 * page in a second tab, and the first tab then fails with
 * `google_state_failed`.
 */
export const appendOAuthStateToCookie = appendGoogleAdsOAuthState;
export const cookieHasOAuthState = hasGoogleAdsOAuthState;
export const removeOAuthStateFromCookie = removeGoogleAdsOAuthState;

function normalizeStates(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((state): state is string => typeof state === 'string')
    .map((state) => state.trim())
    .filter(Boolean)
    .slice(0, MAX_PENDING_STATES);
}

function isLikelyLegacyState(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}
