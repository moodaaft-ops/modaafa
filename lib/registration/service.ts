import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendWelcomeInBackground } from '@/lib/lifecycle/welcome';
import { resolveClientIp } from '@/lib/security/rate-limit';
import { ATTRIBUTION_COOKIE, parseAttributionCookie } from './attribution';
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
};

export async function finalizeForRequest(
  req: NextRequest,
  user: FinalizeUser,
  details?: { name?: string | null; phone?: string | null },
  deps: FinalizeForRequestDeps = {},
) {
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
  if (outcome.status === 'completed') (deps.sendWelcome ?? sendWelcomeInBackground)(user.id);
  return outcome;
}
