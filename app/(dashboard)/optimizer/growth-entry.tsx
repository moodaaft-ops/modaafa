import { createServerClient } from '@/lib/supabase/server';
import { getLinkedGoogleAdsAccount } from '@/lib/accounts/selection';
import { getCustomer } from '@/lib/google-ads/client';
import { decrypt } from '@/lib/crypto';
import { demandGenEnabled, experimentsEnabled, imageAssetsEnabled } from '@/lib/growth/flags';
import { deviceImageUploadEnabled } from '@/lib/image-assets/private-storage';
import { pickStr } from '@/lib/growth/types';
import { GrowthForms } from './growth-forms';
export async function GrowthEntry({ userId, customerId }: { userId: string; customerId: string }) {
  const flags = { demand: demandGenEnabled(), experiment: experimentsEnabled(), image: imageAssetsEnabled() && deviceImageUploadEnabled() };
  if (!Object.values(flags).some(Boolean)) return null;
  const db = await createServerClient();
  const { account } = await getLinkedGoogleAdsAccount({ supabase: db, userId, customerId, select: 'id, customer_id, manager_id, refresh_token_encrypted' });
  if (!account?.refresh_token_encrypted) return null;
  let campaigns: { resource: string; name: string }[] = []; let images: { resource: string; name: string; width: number; height: number }[] = [];
  try {
    const customer = getCustomer(customerId, decrypt(account.refresh_token_encrypted), account.manager_id ?? undefined);
    if (flags.experiment) campaigns = (await customer.query(`SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH' LIMIT 100`))
      .map((r: any) => ({ resource: pickStr(r, 'campaign.resource_name'), name: pickStr(r, 'campaign.name') }));
    if (flags.demand) images = (await customer.query(`SELECT asset.resource_name, asset.name, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM asset WHERE asset.type = 'IMAGE' LIMIT 200`))
      .map((r: any) => ({ resource: pickStr(r, 'asset.resource_name'), name: pickStr(r, 'asset.name') || 'صورة من الحساب', width: Number(pickStr(r, 'asset.image_asset.full_size.width_pixels')), height: Number(pickStr(r, 'asset.image_asset.full_size.height_pixels')) }));
  } catch { /* Empty pickers state which source is missing; never invent assets. */ }
  return <GrowthForms customerId={customerId} flags={flags} campaigns={campaigns} images={images} />;
}
