import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendOpsAlert } from '@/lib/notifications/email';
import {
  inboundAlertsEnabled,
  readWebhookConfig,
  type WhatsAppWebhookConfig,
} from './config';
import { isStopMessage } from './consent';
import { safeEqual, verifyWebhookSignature } from './signature';

export type WhatsAppEvent = {
  /** Message id (wamid). For a status update it is the id of OUR outbound message. */
  wamid: string;
  /** "message" for an inbound message, otherwise the delivery status. */
  eventKey: 'message' | 'sent' | 'delivered' | 'read' | 'failed';
  /** The other party's WhatsApp id (digits, no plus). */
  waId: string;
  kind: string | null;
  body: string | null;
  errorCode: number | null;
  occurredAt: string | null;
};

const MAX_BODY_CHARS = 4096;

/**
 * Flatten Meta's nested webhook payload into events, keeping only what
 * belongs to our own phone number id. Anything unexpected is skipped rather
 * than thrown on: Meta retries a failing webhook for days, so one odd entry
 * must never turn into an endless retry loop.
 */
export function parseWhatsAppPayload(payload: unknown, phoneNumberId: string): WhatsAppEvent[] {
  const events: WhatsAppEvent[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null)?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> } | null)?.value;
      if (!value) continue;
      const metadata = value.metadata as { phone_number_id?: string } | undefined;
      if (metadata?.phone_number_id !== phoneNumberId) continue;

      for (const message of asArray(value.messages)) {
        const wamid = str(message.id);
        const waId = str(message.from);
        if (!wamid || !waId) continue;
        const kind = str(message.type);
        const text = kind === 'text' ? str((message.text as { body?: unknown })?.body) : null;
        events.push({
          wamid,
          eventKey: 'message',
          waId,
          kind,
          body: text ? text.slice(0, MAX_BODY_CHARS) : null,
          errorCode: null,
          occurredAt: epochToIso(message.timestamp),
        });
      }

      for (const status of asArray(value.statuses)) {
        const wamid = str(status.id);
        const waId = str(status.recipient_id);
        const eventKey = str(status.status);
        if (!wamid || !waId) continue;
        if (eventKey !== 'sent' && eventKey !== 'delivered' && eventKey !== 'read' && eventKey !== 'failed') {
          continue;
        }
        const firstError = asArray(status.errors)[0];
        events.push({
          wamid,
          eventKey,
          waId,
          kind: null,
          body: null,
          errorCode: typeof firstError?.code === 'number' ? firstError.code : null,
          occurredAt: epochToIso(status.timestamp),
        });
      }
    }
  }
  return events;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function epochToIso(value: unknown): string | null {
  const seconds = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

type Dependencies = {
  readConfig: () => WhatsAppWebhookConfig | null;
  /** Stores events and returns only the ones that were new (Meta redelivers). */
  recordEvents: (events: WhatsAppEvent[]) => Promise<WhatsAppEvent[]>;
  /** Marks the user behind this WhatsApp id as opted out. */
  applyOptOut: (waId: string) => Promise<void>;
  alertInbound: (event: WhatsAppEvent) => Promise<void>;
  alertsEnabled: () => boolean;
};

const defaultDependencies: Dependencies = {
  readConfig: () => readWebhookConfig(),
  recordEvents: recordEventsInDatabase,
  applyOptOut: applyOptOutInDatabase,
  alertInbound: async (event) => {
    await sendOpsAlert({
      subject: 'رسالة واتساب جديدة على رقم مُضاعِف',
      message: `من ${event.waId}: ${(event.body ?? `(${event.kind ?? 'رسالة بدون نص'})`).slice(0, 300)}`,
    });
  },
  alertsEnabled: () => inboundAlertsEnabled(),
};

/**
 * Webhook handlers for the WhatsApp Cloud API.
 *
 *   GET  answers Meta's one-time subscription handshake.
 *   POST receives messages and delivery statuses, signed with the app secret.
 *
 * Rules that matter:
 *   - an unsigned or wrongly signed POST is rejected before anything is parsed;
 *   - storage failures answer 500 so Meta redelivers, duplicates are absorbed
 *     by the (wamid, event_key) unique key;
 *   - an alert or opt-out failure never changes the answer, the event is
 *     already stored.
 */
export function createWhatsAppWebhookHandler(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { ...defaultDependencies, ...overrides };

  async function GET(request: NextRequest) {
    const config = deps.readConfig();
    if (!config) return new NextResponse('not configured', { status: 503 });

    const params = request.nextUrl.searchParams;
    const challenge = params.get('hub.challenge');
    const token = params.get('hub.verify_token') ?? '';
    if (params.get('hub.mode') === 'subscribe' && challenge && safeEqual(token, config.verifyToken)) {
      return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new NextResponse('forbidden', { status: 403 });
  }

  async function POST(request: NextRequest) {
    const config = deps.readConfig();
    if (!config) return new NextResponse('not configured', { status: 503 });

    const rawBody = await request.text();
    if (!verifyWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'), config.appSecret)) {
      return new NextResponse('invalid signature', { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new NextResponse('invalid json', { status: 400 });
    }

    const events = parseWhatsAppPayload(payload, config.phoneNumberId);
    if (events.length === 0) return NextResponse.json({ ok: true, stored: 0 });

    let fresh: WhatsAppEvent[];
    try {
      fresh = await deps.recordEvents(events);
    } catch (error) {
      console.error('WhatsApp webhook: storing events failed', error);
      return new NextResponse('storage error', { status: 500 });
    }

    for (const event of fresh) {
      if (event.eventKey !== 'message') continue;
      try {
        if (isStopMessage(event.body)) {
          await deps.applyOptOut(event.waId);
        } else if (deps.alertsEnabled()) {
          await deps.alertInbound(event);
        }
      } catch (error) {
        console.error('WhatsApp webhook: follow-up action failed', error);
      }
    }

    return NextResponse.json({ ok: true, stored: fresh.length });
  }

  return { GET, POST };
}

async function recordEventsInDatabase(events: WhatsAppEvent[]): Promise<WhatsAppEvent[]> {
  const supabase = createAdminClient();

  // Link events to a platform user when the number matches one.
  const phones = [...new Set(events.map((event) => `+${event.waId}`))];
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, phone_normalized')
    .in('phone_normalized', phones);
  if (usersError) throw usersError;
  const userByPhone = new Map((users ?? []).map((user) => [user.phone_normalized as string, user.id as string]));

  const rows = events.map((event) => ({
    wamid: event.wamid,
    event_key: event.eventKey,
    wa_id: event.waId,
    user_id: userByPhone.get(`+${event.waId}`) ?? null,
    kind: event.kind,
    body: event.body,
    error_code: event.errorCode,
    occurred_at: event.occurredAt,
  }));

  // ignoreDuplicates makes this ON CONFLICT DO NOTHING, and the returned rows
  // are only the ones actually inserted, which is exactly "new events".
  const { data, error } = await supabase
    .from('whatsapp_events')
    .upsert(rows, { onConflict: 'wamid,event_key', ignoreDuplicates: true })
    .select('wamid, event_key');
  if (error) throw error;

  const inserted = new Set((data ?? []).map((row) => `${row.wamid}:${row.event_key}`));
  return events.filter((event) => inserted.has(`${event.wamid}:${event.eventKey}`));
}

async function applyOptOutInDatabase(waId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('users')
    .update({ whatsapp_opt_out_at: new Date().toISOString() })
    .eq('phone_normalized', `+${waId}`);
  if (error) throw error;
}
