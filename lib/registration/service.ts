import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendWelcomeInBackground } from '@/lib/lifecycle/welcome';
import { resolveClientIp } from '@/lib/security/rate-limit';
import { ATTRIBUTION_COOKIE, parseAttributionCookie } from './attribution';
import { attachReferralFromRequest } from '@/lib/partners/attach';
import { finalizeRegistration, type ClientContext, type FinalizeDeps, type FinalizeUser, type RegistrationDb } from './finalize';

export function clientContextFromRequest(req: NextRequest): ClientContext {
  return {
    ip: resolveClientIp(req),
    userAgent: req.headers.get('user-agent'),
    ttp: req.cookies.get('_ttp')?.value ?? null,
    url: new URL('/welcome', req.nextUrl.origin).toString(),
    referrer: null,
  };
}

/** For tests: the database, the TikTok event and the welcome mail can be replaced. */
export type FinalizeForRequestDeps = {
  db?: RegistrationDb;
  sendServerEvent?: FinalizeDeps['sendServerEvent'];
  sendWelcome?: (userId: string) => void;
  attachReferral?: (req: NextRequest, userId: string) => Promise<unknown>;
  ensureUserRow?: (user: FinalizeUser) => Promise<void>;
};

/**
 * The profile row in public.users is created lazily (nothing creates it when the
 * auth user is created). Someone who clicks the email link or comes back from
 * Google goes straight to finalize_registration, which answers no_user without
 * it. So make sure the row exists first. Never throws: if the insert fails,
 * finalize reports the real failure.
 */
async function ensureUserRowDefault(user: FinalizeUser) {
  if (!user.email) return;
  try {
    const { error } = await createAdminClient()
      .from('users')
      .upsert(
        { id: user.id, email: user.email, last_login_at: new Date().toISOString() },
        { onConflict: 'id', ignoreDuplicates: true },
      );
    if (error) console.warn('[registration] could not ensure the profile row', error.code, error.message?.slice(0, 120));
  } catch {
    console.warn('[registration] could not ensure the profile row');
  }
}

export async function finalizeForRequest(
  req: NextRequest,
  user: FinalizeUser,
  details?: { name?: string | null; phone?: string | null },
  deps: FinalizeForRequestDeps = {},
) {
  if (deps.ensureUserRow) await deps.ensureUserRow(user);
  else if (!deps.db) await ensureUserRowDefault(user);

  const outcome = await finalizeRegistration(
    { db: deps.db ?? (createAdminClient() as unknown as RegistrationDb), sendServerEvent: deps.sendServerEvent },
    user,
    {
      name: details?.name,
      phone: details?.phone,
      cookieAttribution: parseAttributionCookie(req.cookies.get(ATTRIBUTION_COOKIE)?.value),
      client: clientContextFromRequest(req),
    },
  );
  // The welcome mail goes out right after the registration is committed, not
  // when the address is confirmed: a Google user is not registered at that point.
  // Fire and forget; the /api/cron/welcome-email sweep is the safety net.
  if (outcome.status === 'completed') {
    (deps.sendWelcome ?? sendWelcomeInBackground)(user.id);
    // Tie the new user to the partner whose link they used. Never throws.
    await (deps.attachReferral ?? attachReferralFromRequest)(req, user.id);
  }
  return outcome;
}
