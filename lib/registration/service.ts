import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveClientIp } from '@/lib/security/rate-limit';
import { ATTRIBUTION_COOKIE, parseAttributionCookie } from './attribution';
import { finalizeRegistration, type ClientContext, type FinalizeUser, type RegistrationDb } from './finalize';

export function clientContextFromRequest(req: NextRequest): ClientContext {
  return {
    ip: resolveClientIp(req),
    userAgent: req.headers.get('user-agent'),
    ttp: req.cookies.get('_ttp')?.value ?? null,
    url: new URL('/welcome', req.nextUrl.origin).toString(),
    referrer: null,
  };
}

export async function finalizeForRequest(
  req: NextRequest,
  user: FinalizeUser,
  details?: { name?: string | null; phone?: string | null },
) {
  return finalizeRegistration({ db: createAdminClient() as unknown as RegistrationDb }, user, {
    name: details?.name,
    phone: details?.phone,
    cookieAttribution: parseAttributionCookie(req.cookies.get(ATTRIBUTION_COOKIE)?.value),
    client: clientContextFromRequest(req),
  });
}
