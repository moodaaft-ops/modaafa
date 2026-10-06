import { safeLocalPath } from '@/lib/security/redirect';

/**
 * Pure helpers for the email-link sign-in that does NOT depend on a browser
 * cookie (the `token_hash` flow).
 *
 * Why this exists: the default Supabase email link is a one-shot URL that the
 * very first GET consumes. A mail scanner, a link preview, a second click or a
 * stale email from an earlier request all burn it, and the customer lands on
 * `/login?error=auth_callback_failed#error=access_denied&error_code=otp_expired`
 * with a message that blames them. The templates now point at `/auth/confirm`,
 * which only renders a button; the token is spent when the person presses it
 * (POST `/auth/verify`), so a GET can never burn it.
 */

export const EMAIL_OTP_TYPES = ['email', 'magiclink', 'signup'] as const;
export type ConfirmOtpType = (typeof EMAIL_OTP_TYPES)[number];

export type ConfirmParams = {
  tokenHash: string;
  type: ConfirmOtpType;
  next: string;
};

export type ConfirmFailureCode = 'auth_link_expired' | 'auth_callback_failed';

// Supabase hashes are hex, optionally with a `pkce_` prefix. Anything outside
// this alphabet is not a token, so it never reaches the auth API.
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_.-]{16,256}$/;

export function parseConfirmParams(
  input: {
    tokenHash?: string | null;
    type?: string | null;
    next?: string | null;
    redirectTo?: string | null;
  },
  allowedOrigins: string[],
): { ok: true; params: ConfirmParams } | { ok: false } {
  const tokenHash = input.tokenHash?.trim() ?? '';
  const type = input.type?.trim() ?? '';
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) return { ok: false };
  if (!(EMAIL_OTP_TYPES as readonly string[]).includes(type)) return { ok: false };

  return {
    ok: true,
    params: {
      tokenHash,
      type: type as ConfirmOtpType,
      next: resolveConfirmNext(input.next, input.redirectTo, allowedOrigins),
    },
  };
}

/**
 * Where to send the person after a successful verification.
 *
 * The email template carries Supabase's `{{ .RedirectTo }}` (the
 * `emailRedirectTo` the login page passed, e.g.
 * `https://ai.modaafa.com/auth/callback?next=%2Fbilling%3Fplan%3Dgrowth`).
 * It is untrusted data: anyone can request an email with any redirect, so it is
 * only read when it points at this app, and only its `next` path is used.
 */
export function resolveConfirmNext(
  next: string | null | undefined,
  redirectTo: string | null | undefined,
  allowedOrigins: string[],
) {
  if (next) return safeLocalPath(next);
  if (redirectTo) {
    try {
      const url = new URL(redirectTo);
      if (allowedOrigins.includes(url.origin)) {
        return safeLocalPath(url.searchParams.get('next'));
      }
    } catch {
      // Malformed value: fall through to the default.
    }
  }
  return safeLocalPath(null);
}

type VerifyError = { code?: string; message?: string; status?: number };

type VerifyClient = {
  auth: {
    verifyOtp(params: {
      token_hash: string;
      type: ConfirmOtpType;
    }): Promise<{ error: VerifyError | null }>;
  };
};

/**
 * `otp_expired` is what Supabase answers for BOTH an expired and an already
 * used link ("Email link is invalid or has expired"), so the customer-facing
 * message has to cover both. Anything else (network, 5xx) is a generic failure.
 */
export function classifyVerifyError(error: VerifyError | null | undefined): ConfirmFailureCode {
  if (!error) return 'auth_callback_failed';
  if (error.code === 'otp_expired') return 'auth_link_expired';
  if (/expired|invalid|already|used/i.test(error.message ?? '')) return 'auth_link_expired';
  return 'auth_callback_failed';
}

export type EmailVerifyOutcome =
  | { ok: true }
  | { ok: false; code: ConfirmFailureCode; detail: string };

export async function verifyEmailToken(
  supabase: VerifyClient,
  params: Pick<ConfirmParams, 'tokenHash' | 'type'>,
): Promise<EmailVerifyOutcome> {
  try {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: params.tokenHash,
      type: params.type,
    });
    if (!error) return { ok: true };
    // Only the code and status are recorded: never the token and never the
    // message, which can echo the email address.
    return {
      ok: false,
      code: classifyVerifyError(error),
      detail: `code=${error.code ?? 'unknown'} status=${error.status ?? 'n/a'}`,
    };
  } catch {
    return { ok: false, code: 'auth_callback_failed', detail: 'code=thrown status=n/a' };
  }
}

/**
 * Supabase reports a rejected email link in the URL FRAGMENT
 * (`#error=access_denied&error_code=otp_expired&...`). A fragment never reaches
 * the server, so the callback cannot see it; only the login page can read it.
 */
export function authErrorFromHash(hash: string | null | undefined): 'auth_link_expired' | null {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  if (params.get('error_code') === 'otp_expired') return 'auth_link_expired';
  if (params.get('error') === 'access_denied') return 'auth_link_expired';
  return null;
}
