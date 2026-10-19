import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { isConfiguredEnv } from '@/lib/platform/env';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { verifySallaWebhook } from '@/lib/stores/signature';
import { normalizeOrderEvent } from '@/lib/stores/orders';
import { recordOrder } from '@/lib/stores/store';

/**
 * Salla order webhooks (order.created, order.updated and friends).
 * Raw body is verified before parsing. 404 flag off, 503 no secret, 401 bad
 * signature, 400 bad JSON, 200 handled/ignored, 500 DB failure (Salla retries).
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!isStoreSyncEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const secret = process.env.SALLA_WEBHOOK_SECRET;
  if (!isConfiguredEnv(secret)) return NextResponse.json({ error: 'webhook_secret_missing' }, { status: 503 });

  const body = await req.text();
  const verified = verifySallaWebhook({
    secret,
    strategy: req.headers.get('x-salla-security-strategy'),
    signature: req.headers.get('x-salla-signature'),
    authorization: req.headers.get('authorization'),
    tokenHeader: req.headers.get('x-salla-token'),
    rawBody: body,
  });
  if (!verified.ok) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });

  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const event = String((payload as { event?: unknown })?.event ?? '');
  if (!event.startsWith('order.')) return NextResponse.json({ received: true, ignored: 'not_order_event' });
  const merchant = (payload as { merchant?: unknown })?.merchant;
  const storeId = typeof merchant === 'string' || typeof merchant === 'number' ? String(merchant) : null;
  const order = normalizeOrderEvent('salla', payload);
  if (!storeId || !order) return NextResponse.json({ received: true, ignored: 'unreadable' });

  try {
    const out = await recordOrder(createAdminClient(), 'salla', storeId, order);
    return NextResponse.json({ received: true, ...out });
  } catch (error) {
    console.error('Salla webhook processing failed', { event, error });
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}
