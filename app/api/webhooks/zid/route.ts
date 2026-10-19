import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { isConfiguredEnv } from '@/lib/platform/env';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { verifyZidWebhook } from '@/lib/stores/signature';
import { normalizeOrderEvent } from '@/lib/stores/orders';
import { recordOrder } from '@/lib/stores/store';

/**
 * Zid order webhooks. Zid documents no HMAC signature: we require a per-store
 * secret in the target URL (?s=, see zidStoreUrlSecret) AND Basic Auth. Store id
 * comes from ?store= (set when we create the webhook) because the payload shape
 * is unverified; the secret is bound to it, so one store cannot post for another.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!isStoreSyncEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const urlSecret = process.env.ZID_WEBHOOK_URL_SECRET;
  const username = process.env.ZID_WEBHOOK_USERNAME;
  const password = process.env.ZID_WEBHOOK_PASSWORD;
  if (!isConfiguredEnv(urlSecret) || !isConfiguredEnv(username) || !isConfiguredEnv(password)) {
    return NextResponse.json({ error: 'webhook_secret_missing' }, { status: 503 });
  }
  const storeId = req.nextUrl.searchParams.get('store');
  const verified = verifyZidWebhook({
    urlSecret, username, password,
    storeId,
    presentedUrlSecret: req.nextUrl.searchParams.get('s'),
    authorization: req.headers.get('authorization'),
  });
  if (!verified.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let payload: unknown;
  try { payload = JSON.parse(await req.text()); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const order = normalizeOrderEvent('zid', payload);
  if (!storeId || !order) return NextResponse.json({ received: true, ignored: 'unreadable' });
  try {
    const out = await recordOrder(createAdminClient(), 'zid', storeId, order);
    return NextResponse.json({ received: true, ...out });
  } catch (error) {
    console.error('Zid webhook processing failed', { error });
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}
