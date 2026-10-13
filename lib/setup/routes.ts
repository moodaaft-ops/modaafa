/**
 * Where the old onboarding pages send someone who is on the simple
 * experience. The Google callback, Stripe's success page and old links all
 * still point at the old paths, so each old page forwards here instead of
 * every caller changing.
 */
export type OldOnboardingPage = 'business' | 'connect' | 'preparing' | 'choose' | 'first-audit';

const SAFE_CODE = /^[a-z_]{1,40}$/;

export function simpleOnboardingTarget(
  page: OldOnboardingPage,
  params: { error?: string | null; subscribed?: string | null } = {},
  ctx: { hasAccounts?: boolean } = {}
): string {
  if (page === 'first-audit') {
    return params.subscribed === '1' ? '/home?subscribed=1' : '/onboarding';
  }
  if (page === 'business') return ctx.hasAccounts ? '/onboarding?edit=1' : '/onboarding';
  const error = params.error && SAFE_CODE.test(params.error) ? params.error : null;
  // «إضافة حساب» and «تجديد الربط» from inside the app: the chat opens on the connect step.
  const query = [page === 'connect' && ctx.hasAccounts ? 'connect=1' : null, error ? `error=${error}` : null].filter(Boolean);
  return query.length ? `/onboarding?${query.join('&')}` : '/onboarding';
}

const KEPT_ON_HOME = ['subscribed', 'executed', 'approved', 'updated', 'reverted', 'error'] as const;

/** /dashboard, /start and /assistant all become /home; the result params the forms add come along. */
export function homeTargetFrom(params: Record<string, string | string[] | undefined> | null | undefined): string {
  const query = new URLSearchParams();
  for (const key of KEPT_ON_HOME) {
    const raw = params?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && /^[a-z0-9_]{1,40}$/i.test(value)) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `/home?${qs}` : '/home';
}
