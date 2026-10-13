import { buildTikTokEventId } from '@/lib/analytics/tiktok';
import { sendCompleteRegistration, type ServerEventOutcome } from '@/lib/analytics/tiktok-events-api';
import { pickAttribution, type Attribution } from './attribution';
import { cleanName } from './validate';
import { normalizePhone } from './phone';

/**
 * Completes a registration for a signed-in, email-verified user. Safe to call
 * any number of times: the database function is idempotent and the TikTok
 * server event is only sent on the call that actually completed it.
 *
 * Name and phone come from, in order: the details the user typed on the
 * "complete your details" form, then what the first form stored in the auth
 * user's metadata (`reg.phone`, `full_name`). Metadata is user-editable, so it
 * is validated again here exactly like fresh input.
 */
export type FinalizeUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

export type ClientContext = {
  ip?: string | null;
  userAgent?: string | null;
  ttp?: string | null;
  url?: string | null;
  referrer?: string | null;
};

export type FinalizeOutcome =
  | { status: 'completed'; eventId: string; tiktok: ServerEventOutcome }
  | { status: 'already' }
  | { status: 'needs_details'; prefill: { name: string; phone: string }; phoneError?: 'invalid' | 'needs_country_code' }
  | { status: 'phone_taken'; prefill: { name: string; phone: string } }
  | { status: 'failed'; detail: string };

type RpcRow = { result_status: string; result_registered_at: string | null };

/** The slice of the Supabase admin client this module uses (kept narrow so tests can fake it). */
export type RegistrationDb = {
  rpc(fn: 'finalize_registration' | 'record_registration_tiktok', args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type FinalizeDeps = {
  db: RegistrationDb;
  sendServerEvent?: typeof sendCompleteRegistration;
};

type RegistrationMetadata = { phone?: unknown; attribution?: unknown; client?: unknown };

function readMetadata(user: FinalizeUser) {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const reg = (meta.reg && typeof meta.reg === 'object' ? meta.reg : {}) as RegistrationMetadata;
  const name = cleanName(meta.full_name ?? meta.name);
  return { name, reg };
}

export async function finalizeRegistration(
  deps: FinalizeDeps,
  user: FinalizeUser,
  input: {
    /** Typed on the "complete your details" form; wins over metadata. */
    name?: string | null;
    phone?: string | null;
    cookieAttribution: Attribution;
    client: ClientContext;
  },
): Promise<FinalizeOutcome> {
  const { name: metaName, reg } = readMetadata(user);
  const name = cleanName(input.name) || metaName;
  const rawPhone = (typeof input.phone === 'string' && input.phone.trim() ? input.phone : null) ?? (typeof reg.phone === 'string' ? reg.phone : '');
  const prefill = { name, phone: rawPhone };

  const phone = normalizePhone(rawPhone);
  if (!phone.ok || name.length < 2 || name.length > 80) {
    return { status: 'needs_details', prefill, ...(phone.ok || phone.reason === 'empty' ? {} : { phoneError: phone.reason }) };
  }

  const attribution = pickAttribution(reg.attribution, input.cookieAttribution);
  const eventId = buildTikTokEventId('CompleteRegistration', user.id);
  if (!eventId) return { status: 'failed', detail: 'no_user_id' };

  const { data, error } = await deps.db.rpc('finalize_registration', {
    p_user_id: user.id,
    p_name: name,
    p_phone_normalized: phone.e164,
    p_attribution: attribution,
    p_event_id: eventId,
  });
  if (error) return { status: 'failed', detail: error.message.slice(0, 160) };

  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null;
  switch (row?.result_status) {
    case 'already':
      return { status: 'already' };
    case 'phone_taken':
      return { status: 'phone_taken', prefill };
    case 'completed':
      break;
    default:
      return { status: 'failed', detail: row?.result_status ?? 'no_result' };
  }

  // Click id and TikTok cookie: prefer what was captured when the form was
  // submitted (the browser that saw the ad), then this request's own.
  const storedClient = (reg.client && typeof reg.client === 'object' ? reg.client : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
  const send = deps.sendServerEvent ?? sendCompleteRegistration;
  const tiktok = await send({
    userId: user.id,
    ttclid: attribution.ttclid ?? null,
    ttp: str(storedClient.ttp) ?? input.client.ttp ?? null,
    ip: str(storedClient.ip) ?? input.client.ip ?? null,
    userAgent: str(storedClient.ua) ?? input.client.userAgent ?? null,
    url: input.client.url ?? null,
    referrer: input.client.referrer ?? null,
  });

  // Leave a trace on the event row so "did TikTok get it?" is answerable from SQL.
  try {
    await deps.db.rpc('record_registration_tiktok', { p_user_id: user.id, p_outcome: tiktok });
  } catch {
    // Best effort: the registration itself is already committed.
  }

  return { status: 'completed', eventId, tiktok };
}
