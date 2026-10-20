'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_SPECS, ratioMatches, meetsMinimum, type ImageSlot } from '@/lib/image-assets/requirements';
const field = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm';
type Option = { resource: string; name: string };
export function GrowthForms({ customerId, flags, campaigns, images }: {
 customerId: string; flags: { demand: boolean; experiment: boolean; image: boolean }; campaigns: Option[]; images: (Option & { width: number; height: number })[];
}) {
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const router = useRouter();
  const lines = (f: FormData, key: string) => String(f.get(key) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  async function submit(event: React.FormEvent<HTMLFormElement>, kind: string) {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = new FormData(event.currentTarget);
    let url = '/api/growth/propose'; let options: RequestInit;
    if (kind === 'device_image') {
      form.set('customerId', customerId); url = '/api/growth/images'; options = { method: 'POST', body: form };
    } else {
      const input = kind === 'demand_gen' ? {
        name: form.get('name'), daily_budget_sar: Number(form.get('budget')), bidding_strategy: form.get('strategy'), landing_page: form.get('landing_page'),
        headlines: lines(form, 'headlines'), long_headlines: lines(form, 'long_headlines'), descriptions: lines(form, 'descriptions'), target_regions: lines(form, 'regions'), youtube_video: form.get('youtube'),
        marketing_images: [form.get('marketing')].filter(Boolean), square_images: [form.get('square')].filter(Boolean), logo_images: [form.get('logo')].filter(Boolean),
      } : { campaign_resource: form.get('campaign'), kind: form.get('experiment_kind'), final_url: form.get('final_url'), strategy: form.get('strategy'), name: form.get('name') };
      options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId, kind, input }) };
    }
    try {
      const response = await fetch(url, options); const data = await response.json();
      const blockers = data.plan?.blockers ?? data.blockers ?? [];
      setMessage(data.card_id || data.cardId ? 'جهزنا بطاقة الموافقة، راجع تفاصيلها تحت' : blockers.length ? blockers.map((b: any) => b.message_ar).filter(Boolean).join('، ') : data.error === 'image_fit' ? 'الصورة ما تناسب المقاس أو الحجم، اختر صورة ثانية' : 'ما قدرنا نجهز الطلب، تأكد من البيانات والربط وجرّب مرة ثانية');
      if (data.card_id || data.cardId) router.refresh();
    } catch { setMessage('ما اكتمل الاتصال، جرّب مرة ثانية'); } finally { setBusy(false); }
  }
  const imagePicker = (slot: ImageSlot, name: string, label: string) => {
    const options = images.filter((i) => ratioMatches(i.width, i.height, SLOT_SPECS[slot]) && meetsMinimum(i.width, i.height, SLOT_SPECS[slot]));
    return <label className="grid gap-1">{label}<select name={name} className={field} defaultValue=""><option value="">اختر صورة</option>{options.map((i) => <option key={i.resource} value={i.resource}>{i.name} ({i.width} × {i.height})</option>)}</select></label>;
  };
  const button = <button disabled={busy} className="rounded-full bg-primary px-5 py-2 text-primary-foreground disabled:opacity-50 self-start">{busy ? 'نجهّز الطلب' : 'جهّز بطاقة للمراجعة'}</button>;
  return <section dir="rtl" className="mb-6 space-y-3" aria-label="أفكار النمو والتجارب">
    <p className="text-sm text-muted-foreground">جهّز فكرة للنمو أو تجربة، وكل تغيير ينتظر موافقتك</p>
    {message && <p role="status" className="rounded-xl bg-secondary p-4 text-sm leading-7">{message}</p>}
    {flags.demand && <details className="surface-card p-4"><summary className="cursor-pointer font-semibold">حملة ديماند جن</summary>
      <form onSubmit={(e) => submit(e, 'demand_gen')} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">اسم الحملة<input name="name" required maxLength={100} className={field} /></label>
        <label className="grid gap-1">ميزانيتك اليومية بالريال<input name="budget" required type="number" min={20} max={5000} step="0.01" className={field} /></label>
        <label className="grid gap-1">صفحة الإعلان<input name="landing_page" required type="url" dir="ltr" className={field} /></label>
        <label className="grid gap-1">المزايدة<select name="strategy" className={field}><option value="MAXIMIZE_CLICKS">تعظيم النقرات</option><option value="MAXIMIZE_CONVERSIONS">تعظيم التحويلات</option></select></label>
        <label className="grid gap-1">العناوين، كل عنوان بسطر<textarea name="headlines" required className={field} /></label>
        <label className="grid gap-1">الأوصاف، كل وصف بسطر<textarea name="descriptions" required className={field} /></label>
        <label className="grid gap-1">المدن، كل مدينة بسطر<textarea name="regions" required className={field} /></label>
        <label className="grid gap-1">رابط فيديو يوتيوب إن وجد<input name="youtube" dir="ltr" className={field} /></label>
        <label className="grid gap-1">عنوان طويل للفيديو إن وجد<textarea name="long_headlines" className={field} /></label>
        {imagePicker('marketing', 'marketing', 'الصورة الأفقية')}{imagePicker('square', 'square', 'الصورة المربعة')}{imagePicker('logo', 'logo', 'شعار النشاط')}
        {!images.length && <p className="text-sm">ما قدرنا نلقى صور بالحساب، ارفع صورك من الخيار اللي تحت ووافق على إضافتها أول</p>}{button}
      </form></details>}
    {flags.experiment && <details className="surface-card p-4"><summary className="cursor-pointer font-semibold">جرّب تغيير على حملة</summary>
      <form onSubmit={(e) => submit(e, 'experiment')} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">اسم التجربة<input name="name" required className={field} maxLength={100} /></label>
        <label className="grid gap-1">الحملة<select name="campaign" required className={field}><option value="">اختر حملة بحث شغالة</option>{campaigns.map((c) => <option key={c.resource} value={c.resource}>{c.name}</option>)}</select></label>
        <label className="grid gap-1">وش نختبر<select name="experiment_kind" className={field}><option value="landing_page">صفحة الهبوط</option><option value="bidding_strategy">تعظيم التحويلات</option></select></label>
        <label className="grid gap-1">الصفحة الجديدة لاختبار الصفحة<input name="final_url" type="url" dir="ltr" className={field} /></label>
        <input type="hidden" name="strategy" value="MAXIMIZE_CONVERSIONS" />{button}
      </form></details>}
    {flags.image && <details className="surface-card p-4"><summary className="cursor-pointer font-semibold">ارفع صورة من جهازك</summary>
      <form onSubmit={(e) => submit(e, 'device_image')} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">صورتك<input type="file" name="image" accept="image/png,image/jpeg" required className={field} /></label>
        <label className="grid gap-1">استخدام الصورة<select name="slot" className={field}><option value="marketing">إعلان أفقي، 1.91 إلى 1</option><option value="square">إعلان مربع</option><option value="portrait">إعلان عمودي، 4 إلى 5</option><option value="logo">شعار مربع</option></select></label>
        <p className="text-sm">PNG أو JPG، إلى 4 ميغابايت، الصورة تنحفظ بشكل خاص لين توافق على رفعها للحساب</p>{button}
      </form></details>}
  </section>;
}
