import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createServerClient } from '@/lib/supabase/server';
import { getLinkedGoogleAdsAccount, normalizeCustomerId } from '@/lib/accounts/selection';
import { isSameOriginRequest } from '@/lib/security/origin';
import { checkRateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { imageAssetsEnabled } from '@/lib/growth/flags';
import { createGrowthCard, growthCardRow } from '@/lib/growth/card';
import { DEVICE_IMAGE_MAX_BYTES, IMAGE_BUCKET, deviceImageItem, deviceImageUploadEnabled, storageImagePath } from '@/lib/image-assets/private-storage';
import type { ImageSlot } from '@/lib/image-assets/requirements';
export async function POST(req: NextRequest) {
  if (!imageAssetsEnabled() || !deviceImageUploadEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isSameOriginRequest(req)) return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  if (Number(req.headers.get('content-length')) > DEVICE_IMAGE_MAX_BYTES + 10000) return NextResponse.json({ error: 'image_too_large' }, { status: 413 });
  const db = await createServerClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const limit = await checkRateLimit({ req, scope: 'device_image', limit: 10, windowSeconds: 600, identifier: user.id });
    if (!limit.allowed) return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: rateLimitHeaders(limit) });
    const form = await req.formData(); const file = form.get('image');
    const customerId = normalizeCustomerId(String(form.get('customerId') ?? ''));
    if (!customerId || !(file instanceof File) || file.size > DEVICE_IMAGE_MAX_BYTES) return NextResponse.json({ error: 'invalid_image' }, { status: 400 });
    const { account } = await getLinkedGoogleAdsAccount({ supabase: db, userId: user.id, customerId, select: 'id, customer_id' });
    if (!account) return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const item = deviceImageItem(bytes, String(form.get('slot')) as ImageSlot, customerId, user.id);
    if (!item) return NextResponse.json({ error: 'image_fit' }, { status: 400 });
    const admin = createAdminClient(); const path = storageImagePath(item.url)!;
    const { error } = await admin.storage.from(IMAGE_BUCKET).upload(path, bytes, { upsert: false, contentType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    if (error && error.message !== 'The resource already exists') throw new Error('image_storage_failed');
    const card = await createGrowthCard(admin, growthCardRow(account.id, 'create_image_assets', { images: [item] },
      'نرفع صورتك لحساب الإعلانات بعد موافقتك، وما تظهر بإعلان لين تنربط بحملة', 'assets'));
    return NextResponse.json({ card_id: card.id });
  } catch { return NextResponse.json({ error: 'image_upload_failed' }, { status: 500 }); }
}
