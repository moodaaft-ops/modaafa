import { SNIPPET_HEADER_AR } from './types';

export type StudioPreviewRow = { label: string; value: string; ltr?: boolean };

const FIELD_AR: Record<string, string> = { HEADLINE: 'عنوان', DESCRIPTION: 'وصف' };

/**
 * Approval-card rows for the ad-assets operations. Pure and Arabic (Saudi
 * colloquial, no dashes). The cards show the exact texts, so the merchant
 * approves what will run, not a summary of it.
 */
export function adsStudioPreviewRows(operation: string, params: Record<string, any>, targetId?: string): StudioPreviewRow[] {
  const rows: StudioPreviewRow[] = [];
  switch (operation) {
    case 'replace_rsa_assets': {
      const replacements: any[] = Array.isArray(params.replacements) ? params.replacements : [];
      rows.push({
        label: 'طريقة التنفيذ',
        value:
          params.mode === 'test_variant'
            ? 'نسخة ثانية تشتغل جنب الحالية للاختبار'
            : 'إعلان جديد يحل محل الحالي، والقديم يتوقف ويبقى محفوظ',
      });
      for (const r of replacements.slice(0, 7)) {
        rows.push({ label: `${FIELD_AR[r.field] ?? ''} قديم`, value: String(r.old_text) });
        rows.push({ label: `${FIELD_AR[r.field] ?? ''} جديد`, value: String(r.new_text) });
      }
      rows.push({ label: 'الإعلان', value: String(params.ad_group_ad_resource ?? targetId ?? ''), ltr: true });
      break;
    }
    case 'add_sitelinks': {
      const items: any[] = Array.isArray(params.sitelinks) ? params.sitelinks : [];
      for (const s of items.slice(0, 6)) {
        rows.push({ label: String(s.link_text), value: `${s.description1}، ${s.description2}` });
        rows.push({ label: 'الرابط', value: String(s.final_url), ltr: true });
      }
      break;
    }
    case 'add_callouts': {
      const items: unknown[] = Array.isArray(params.callouts) ? params.callouts : [];
      rows.push({ label: `العبارات (${items.length})`, value: items.map(String).join('، ') });
      break;
    }
    case 'add_structured_snippet': {
      const items: unknown[] = Array.isArray(params.values) ? params.values : [];
      rows.push({ label: 'العنوان', value: SNIPPET_HEADER_AR[String(params.header)] ?? String(params.header) });
      rows.push({ label: `القيم (${items.length})`, value: items.map(String).join('، ') });
      break;
    }
    case 'add_call_asset':
      rows.push({ label: 'رقم الاتصال', value: String(params.phone_number ?? ''), ltr: true });
      break;
  }
  return rows;
}
