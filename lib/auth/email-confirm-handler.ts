import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginRequest } from '@/lib/security/origin';
import { parseConfirmParams, verifyEmailToken } from '@/lib/auth/email-confirm';

type VerifyOtpClient = Parameters<typeof verifyEmailToken>[0];

export type EmailVerifyDependencies = {
  createSupabase: () => Promise<VerifyOtpClient>;
};

function toLogin(req: NextRequest, code: string) {
  return NextResponse.redirect(new URL(`/login?error=${code}`, req.url), 303);
}

function allowedOrigins(req: NextRequest) {
  const origins = [req.nextUrl.origin];
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      origins.push(new URL(configured).origin);
    } catch {
      // A malformed env var must not break sign-in.
    }
  }
  return origins;
}

/**
 * POST /auth/verify: spends the email token. It is a POST on purpose, so a link
 * scanner or preview that only issues GETs cannot consume it.
 */
export function createEmailVerifyHandler(deps: EmailVerifyDependencies) {
  return async function POST(req: NextRequest) {
    // Without this, an attacker holding their own valid token could make a
    // victim's browser POST it and sign the victim into the attacker's account.
    if (!isSameOriginRequest(req)) return toLogin(req, 'invalid_origin');

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return toLogin(req, 'auth_callback_failed');
    }
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : null;
    };

    const parsed = parseConfirmParams(
      {
        tokenHash: field('token_hash'),
        type: field('type'),
        next: field('next'),
        redirectTo: field('redirect_to'),
      },
      allowedOrigins(req),
    );
    if (!parsed.ok) return toLogin(req, 'auth_callback_failed');

    const supabase = await deps.createSupabase();
    const outcome = await verifyEmailToken(supabase, parsed.params);
    if (!outcome.ok) {
      console.warn(`[auth/verify] failed ${outcome.detail}`);
      return toLogin(req, outcome.code);
    }

    return NextResponse.redirect(new URL(parsed.params.next, req.nextUrl.origin), 303);
  };
}
