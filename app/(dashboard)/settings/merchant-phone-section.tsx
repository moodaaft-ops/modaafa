import { createServerClient } from '@/lib/supabase/server';
import { merchantPhoneEnabled } from '@/lib/settings/merchant-phone';
import { CARD, CalmHeading, CalmNote, FIELD, pill } from '../calm-page';
export async function MerchantPhoneSection({ businessId, outcome }: { businessId?: string; outcome?: string }) {
  if (!merchantPhoneEnabled() || !businessId) return null;
  const db = await createServerClient();
  const { data } = await db.from('merchant_call_phones').select('phone_e164').eq('business_id', businessId).maybeSingle();
  const local = data?.phone_e164?.replace(/^\+966/, '0') ?? '';
  return <section className="mt-8" dir="rtl">
    <CalmHeading title="رقم اتصال النشاط" hint="نستخدمه لاقتراح إضافة اتصال، والإضافة تنتظر موافقتك" />
    {outcome && <CalmNote tone={outcome === 'saved' ? 'success' : 'danger'}>{outcome === 'saved' ? 'حفظنا رقم النشاط' : 'اكتب رقم جوال يبدأ بـ 05 وأكد إنه رقم النشاط'}</CalmNote>}
    <form action="/api/settings/merchant-phone" method="post" className={`${CARD} mt-3 flex max-w-xl flex-col gap-4 p-5`}>
      <input type="hidden" name="business_id" value={businessId} />
      <label className="flex flex-col gap-2">رقم الجوال<input className={FIELD} name="phone" type="tel" inputMode="tel" dir="ltr" placeholder="05XXXXXXXX" pattern="05[0-9]{8}" maxLength={10} defaultValue={local} required /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" required className="mt-1" />أأكد إن هالرقم يستقبل اتصالات عملاء النشاط ويصلح يظهر بالإعلان</label>
      <button className={`${pill.primary} self-start`} type="submit">احفظ الرقم</button>
    </form>
  </section>;
}
