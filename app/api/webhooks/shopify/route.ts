import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { isConfiguredEnv } from '@/lib/platform/env';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { verifyShopifyWebhook } from '@/lib/stores/signature';
import { normalizeShopifyOrder } from '@/lib/stores/orders';
import { recordOrder } from '@/lib/stores/store';
import { normalizeShopDomain } from '@/lib/stores/oauth';

/**
 * Shopify order webhooks (orders/create, orders/updated, orders/cancelled,
 * orders/paid). X-Shopify-Hmac-Sha256 over the raw body with the app secret.
 * 404 flag off, 503 no secret, 401 bad HMAC, 400 bad JSON, 500 DB failure.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!isStoreSyncEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!isConfiguredEnv(secret)) return NextResponse.json({ error: 'webhook_secret_missing' }, { status: 503 });

  const body = await req.text();
  const verified = verifyShopifyWebhook({ secret, hmacHeader: req.headers.get('x-shopify-hmac-sha256'), rawBody: body });
  if (!verified.ok) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });

  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const topic = req.headers.get('x-shopify-topic') ?? '';
  const shop = normalizeShopDomain(req.headers.get('x-shopify-shop-domain'));
  if (!topic.startsWith('orders/')) return NextResponse.json({ received: true, ignored: 'not_order_topic' });
  const order = normalizeShopifyOrder(topic, payload);
  if (!shop || !order) return NextResponse.json({ received: true, ignored: 'unreadable' });

  try {
    const out = await recordOrder(createAdminClient(), 'shopify', shop, order);
    return NextResponse.json({ received: true, ...out });
  } catch (error) {
    console.error('Shopify webhook processing failed', { topic, error });
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}
