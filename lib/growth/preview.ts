import { SLOT_LABEL_AR, type ImageSlot } from '../image-assets/requirements';

/** What the merchant reads on the card before approving. Pure strings; the page renders the rows. */
export type PreviewRow = { label: string; value: string; ltr?: boolean };

const sar = (n: unknown) => `${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)} ريال`;
const rec = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

export function growthPreviewRows(operation: string, params: unknown): PreviewRow[] {
  const p = rec(params);
  switch (operation) {
    case 'launch_demand_gen': {
      const plan = rec(p.plan);
      const rows: PreviewRow[] = [
        { label: 'الحملة', value: String(plan.name ?? '') },
        { label: 'الميزانية اليومية', value: sar(plan.budget?.daily_sar) },
        { label: 'الحالة بعد البناء', value: 'موقوفة، ما تصرف شي لين تشغلها' },
        { label: 'الصفحة', value: String(plan.final_url ?? ''), ltr: true },
        { label: 'الإعلان', value: plan.video ? 'فيديو يوتيوب' : 'صور ونصوص' },
      ];
      const lists = Array.isArray(plan.audience?.user_lists) ? plan.audience.user_lists.length : 0;
      if (lists) rows.push({ label: 'قوائم الجمهور', value: String(lists) });
      return rows;
    }
    case 'upload_customer_match': return [{ label: 'القائمة', value: String(p.user_list_resource ?? ''), ltr: true }, { label: 'عدد العملاء', value: String(p.members?.length ?? 0) }, { label: 'البيانات', value: 'بصمات مشفرة للبريد والجوال فقط' }];
    case 'create_user_list':
      return [
        { label: 'الاسم', value: String(p.name ?? '') },
        { label: 'النوع', value: p.kind === 'customer_match' ? 'قائمة عملاء' : 'زوار الموقع' },
        ...(p.kind === 'website_visitors' ? [{ label: 'مدة البقاء', value: `${p.lookback_days ?? ''} يوم` }] : []),
      ];
    case 'attach_audience':
      return [
        { label: 'المجموعة', value: String(p.ad_group_resource ?? ''), ltr: true },
        { label: 'القائمة', value: String(p.user_list_resource ?? ''), ltr: true },
      ];
    case 'create_experiment': {
      const plan = rec(p.plan);
      return [
        { label: 'الحملة', value: String(plan.campaign_name ?? plan.campaign_resource ?? '') },
        { label: 'التغيير', value: plan.change?.type === 'bidding' ? 'استراتيجية المزايدة' : 'صفحة الهبوط' },
        { label: 'نسبة التجربة', value: `${plan.treatment_split ?? ''}٪` },
        { label: 'من', value: String(plan.start_date ?? ''), ltr: true },
        { label: 'إلى', value: String(plan.end_date ?? ''), ltr: true },
      ];
    }
    case 'end_experiment':
    case 'promote_experiment':
      return [{ label: 'التجربة', value: String(p.experiment_resource ?? ''), ltr: true }];
    case 'create_image_assets': {
      const images: any[] = Array.isArray(p.images) ? p.images : [];
      return images.map((img) => ({
        label: SLOT_LABEL_AR[img.slot as ImageSlot] ?? String(img.slot ?? ''),
        value: `${img.width}×${img.height}  ${String(img.url ?? '')}`,
        ltr: true,
      }));
    }
    default:
      return [];
  }
}
