import { createServerClient } from '@/lib/supabase/server';
import { isStoreSyncEnabled } from '@/lib/stores/flags';
import { zidWebhookDetails, ZID_ORDER_EVENTS } from '@/lib/stores/zid-webhooks';
import { CARD } from '../calm-page';
export async function ZidWebhookSection() {
  if (!isStoreSyncEnabled()) return null;
  const db = await createServerClient();
  const { data } = await db.from('store_connections').select('external_store_id').eq('platform', 'zid').eq('status', 'active');
  return <>{(data ?? []).map((store) => {
    const details = zidWebhookDetails(store.external_store_id); if (!details) return null;
    return <details key={store.external_store_id} className={`${CARD} mt-3 p-5`} dir="rtl"><summary className="cursor-pointer font-semibold">ربط طلبات زد للمتجر {store.external_store_id}</summary>
      <p className="my-3 text-sm leading-7">نسجل الربط تلقائياً إذا صلاحية تطبيقك تسمح، وإذا ما وصلت الطلبات أضف الأحداث التالية من إعدادات الربط في زد</p>
      <p dir="ltr" className="break-all text-sm">{ZID_ORDER_EVENTS.join(' · ')}</p>
      <div className="mt-3 grid gap-3"><label>رابط الاستقبال<input className="mt-1 w-full rounded border p-2 text-sm" dir="ltr" readOnly value={details.url} /></label>
        <label>اسم المستخدم<input className="mt-1 w-full rounded border p-2 text-sm" dir="ltr" readOnly value={details.username} /></label>
        <label>كلمة مرور الربط<input type="password" className="mt-1 w-full rounded border p-2 text-sm" dir="ltr" readOnly value={details.password} /></label></div>
    </details>;
  })}</>;
}
