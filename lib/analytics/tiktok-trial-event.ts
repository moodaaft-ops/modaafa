import { sendSubscribe, TIKTOK_EVENTS_API_TOKEN_ENV, type ServerEventOutcome } from './tiktok-events-api';

/**
 * Reports a trial start to TikTok from the server, so the ad that brought the
 * user gets the credit even when the Stripe return lands in another browser
 * (or never reaches /dashboard at all). This is the event the TikTok ad group
 * optimises on.
 *
 * The click id comes from `users.registration_source` (written when the
 * registration completed) and, as a fallback, from the auth user's
 * `reg.attribution`. The TikTok cookie, IP and user agent come from
 * `reg.client`, captured on the device that saw the ad. No email, phone or
 * name is sent.
 *
 * Never throws: a trial must not fail because TikTok is slow or down. Sending
 * twice (checkout return and webhook both call this) is harmless, TikTok
 * keeps one per `event_id` (`sub_<user id>`, same as the browser pixel).
 */

export type TrialEventOutcome = ServerEventOutcome | { status: 'skipped'; reason: 'no_match_keys' | 'lookup_failed' };

type AdminLike = { from: (table: string) => any; auth?: any };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export async function reportTrialStartToTikTok({
  admin,
  userId,
  env = process.env,
  send = sendSubscribe,
}: {
  admin: AdminLike;
  userId: string;
  env?: Record<string, string | undefined>;
  send?: typeof sendSubscribe;
}): Promise<TrialEventOutcome> {
  // No token means nothing would be sent anyway; skip the lookups too.
  if (!env[TIKTOK_EVENTS_API_TOKEN_ENV]?.trim()) return { status: 'skipped', reason: 'no_token' };

  let ttclid: string | null = null;
  let client: Record<string, unknown> = {};
  try {
    const { data } = await admin.from('users').select('registration_source').eq('id', userId).maybeSingle();
    ttclid = str(obj(data?.registration_source).ttclid);
  } catch {
    // fall through to the auth metadata
  }
  try {
    const { data } = (await admin.auth?.admin?.getUserById(userId)) ?? {};
    const reg = obj(obj(data?.user?.user_metadata).reg);
    ttclid = ttclid ?? str(obj(reg.attribution).ttclid);
    client = obj(reg.client);
  } catch {
    if (!ttclid) return { status: 'skipped', reason: 'lookup_failed' };
  }

  const ttp = str(client.ttp);
  // Without a click id or the TikTok cookie the event cannot be tied to an ad,
  // and an unattributable Subscribe only adds noise to the optimisation.
  if (!ttclid && !ttp) return { status: 'skipped', reason: 'no_match_keys' };

  try {
    return await send({ userId, ttclid, ttp, ip: str(client.ip), userAgent: str(client.ua) }, { env });
  } catch {
    return { status: 'failed', detail: 'error' };
  }
}
