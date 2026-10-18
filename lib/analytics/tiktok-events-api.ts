import { buildTikTokEventId, resolveTikTokPixelId, type TikTokConversionEvent } from './tiktok';

/**
 * Server half of the TikTok conversion report (Events API 2.0).
 *
 * The browser pixel and this call report the SAME registration with the SAME
 * `event_id` (`reg_<user id>`, from buildTikTokEventId), so TikTok counts it
 * once. Whichever side is blocked (ad blocker, closed tab, a server hiccup)
 * the other still delivers.
 *
 * Like the pixel, no personal data is sent: only the click id, TikTok's own
 * `_ttp` cookie, the IP and the user agent. Adding hashed email / phone would
 * improve matching but changes what the privacy page promises, so it is left
 * as an explicit product decision.
 *
 * Env (server only):
 *   TIKTOK_PIXEL_ID           already used by the pixel; doubles as event_source_id
 *   TIKTOK_EVENTS_API_TOKEN   Events Manager > Settings > Generate Access Token
 *   TIKTOK_TEST_EVENT_CODE    only while testing. While set, events go to the
 *                             Test Events tab and DO NOT count for optimization.
 */
export const TIKTOK_EVENTS_API_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
export const TIKTOK_EVENTS_API_TOKEN_ENV = 'TIKTOK_EVENTS_API_TOKEN';
export const TIKTOK_TEST_EVENT_CODE_ENV = 'TIKTOK_TEST_EVENT_CODE';

export type ServerEventContext = {
  userId: string;
  ttclid?: string | null;
  ttp?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  url?: string | null;
  referrer?: string | null;
  /** Unix seconds. Defaults to now. */
  eventTime?: number;
};

export type TikTokServerPayload = {
  event_source: 'web';
  event_source_id: string;
  test_event_code?: string;
  data: Array<{
    event: TikTokConversionEvent;
    event_time: number;
    event_id: string;
    user: { ttclid?: string; ttp?: string; ip?: string; user_agent?: string };
    page?: { url?: string; referrer?: string };
    properties: Record<string, never>;
  }>;
};

const TEST_CODE_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

function compact<T extends Record<string, string | undefined>>(input: T) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 500);
  }
  return out as { [K in keyof T]?: string };
}

/**
 * One server event, CompleteRegistration or Subscribe (trial start). The
 * event_id matches the browser pixel's (`reg_` / `sub_` + user id), so when
 * both arrive TikTok keeps one.
 */
export function buildServerEventPayload(
  event: TikTokConversionEvent,
  rawPixelId: string | null | undefined,
  ctx: ServerEventContext,
  testEventCode?: string | null,
): TikTokServerPayload | null {
  const pixelId = resolveTikTokPixelId(rawPixelId);
  const eventId = buildTikTokEventId(event, ctx.userId);
  if (!pixelId || !eventId) return null;

  const payload: TikTokServerPayload = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [
      {
        event,
        event_time: ctx.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: eventId,
        user: compact({
          ttclid: ctx.ttclid ?? undefined,
          ttp: ctx.ttp ?? undefined,
          ip: ctx.ip ?? undefined,
          user_agent: ctx.userAgent ?? undefined,
        }),
        page: compact({ url: ctx.url ?? undefined, referrer: ctx.referrer ?? undefined }),
        properties: {},
      },
    ],
  };

  const code = testEventCode?.trim();
  if (code && TEST_CODE_PATTERN.test(code)) payload.test_event_code = code;
  return payload;
}

export function buildCompleteRegistrationPayload(
  rawPixelId: string | null | undefined,
  ctx: ServerEventContext,
  testEventCode?: string | null,
): TikTokServerPayload | null {
  return buildServerEventPayload('CompleteRegistration', rawPixelId, ctx, testEventCode);
}

export type ServerEventOutcome =
  | { status: 'sent'; testMode: boolean }
  | { status: 'skipped'; reason: 'no_pixel' | 'no_token' }
  | { status: 'failed'; detail: string };

/**
 * Never throws and never waits longer than `timeoutMs`: a registration must not
 * fail, or hang, because TikTok is slow.
 */
type SendOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function sendCompleteRegistration(
  ctx: ServerEventContext,
  options: SendOptions = {},
): Promise<ServerEventOutcome> {
  return sendServerEvent('CompleteRegistration', ctx, options);
}

/** Trial started (card on file through Stripe). Same rules as the registration event. */
export async function sendSubscribe(ctx: ServerEventContext, options: SendOptions = {}): Promise<ServerEventOutcome> {
  return sendServerEvent('Subscribe', ctx, options);
}

export async function sendServerEvent(
  event: TikTokConversionEvent,
  ctx: ServerEventContext,
  options: SendOptions = {},
): Promise<ServerEventOutcome> {
  const env = options.env ?? process.env;
  const token = env[TIKTOK_EVENTS_API_TOKEN_ENV]?.trim();
  const payload = buildServerEventPayload(event, env.TIKTOK_PIXEL_ID, ctx, env[TIKTOK_TEST_EVENT_CODE_ENV]);
  if (!payload) return { status: 'skipped', reason: 'no_pixel' };
  if (!token) return { status: 'skipped', reason: 'no_token' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  try {
    const res = await (options.fetchImpl ?? fetch)(TIKTOK_EVENTS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': token },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
    if (!res.ok || !body || body.code !== 0) {
      // Never log the token or the payload; the TikTok code and message are enough to debug.
      return { status: 'failed', detail: `http ${res.status} code ${body?.code ?? '?'} ${String(body?.message ?? '').slice(0, 120)}`.trim() };
    }
    return { status: 'sent', testMode: Boolean(payload.test_event_code) };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.name : 'error' };
  } finally {
    clearTimeout(timer);
  }
}
