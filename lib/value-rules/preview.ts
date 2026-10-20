export type ValueRulePreviewRow = { label: string; value: string; ltr?: boolean };

const DEVICE_AR: Record<string, string> = { MOBILE: 'الجوال', DESKTOP: 'الكمبيوتر', TABLET: 'التابلت' };
const DIMENSION_AR: Record<string, string> = { GEO_LOCATION: 'الموقع', DEVICE: 'الجهاز', AUDIENCE: 'الجمهور' };

function pct(multiplier: unknown): string {
  const m = Number(multiplier);
  if (!Number.isFinite(m)) return '';
  const change = Math.round((m - 1) * 100);
  if (change === 0) return 'بدون تغيير';
  return change > 0 ? `قيمة التحويل أعلى ${change}%` : `قيمة التحويل أقل ${Math.abs(change)}%`;
}

/**
 * Approval-card rows for the value rule actions. Pure, Arabic (Saudi
 * colloquial, no dashes). The card shows what Smart Bidding will believe about
 * the worth of a conversion, not the mechanics.
 */
export function valueRulePreviewRows(operation: string, params: Record<string, any>, targetId?: string): ValueRulePreviewRow[] {
  const rows: ValueRulePreviewRow[] = [];
  if (operation === 'create_value_rule_set') {
    rows.push({ label: 'النطاق', value: params.attachment === 'campaign' ? 'حملة وحدة' : 'كل الحساب' });
    if (params.campaign_resource) rows.push({ label: 'الحملة', value: String(params.campaign_resource), ltr: true });
    rows.push({ label: 'حسب', value: DIMENSION_AR[String(params.dimension)] ?? String(params.dimension) });
    const rules: any[] = Array.isArray(params.rules) ? params.rules : [];
    for (const rule of rules.slice(0, 5)) {
      const who =
        params.dimension === 'DEVICE'
          ? (rule.device_types ?? []).map((d: string) => DEVICE_AR[d] ?? d).join('، ')
          : params.dimension === 'GEO_LOCATION'
            ? `${(rule.geo_target_constants ?? []).length} موقع`
            : `${(rule.user_lists ?? []).length} جمهور`;
      rows.push({ label: String(rule.label ?? who), value: `${who}: ${pct(rule.multiplier)}` });
    }
    rows.push({ label: 'ملاحظة', value: 'تتغير القيمة اللي تتعلم عليها المزايدة الذكية، وما تتغير مبيعاتك الفعلية' });
    return rows;
  }
  if (operation === 'update_value_rule') {
    const resolved = (params.resolved ?? {}) as Record<string, any>;
    rows.push({ label: 'القاعدة', value: String(params.rule_resource ?? targetId ?? ''), ltr: true });
    if (params.multiplier !== undefined) {
      if (resolved.previous_multiplier !== undefined) rows.push({ label: 'قبل', value: pct(resolved.previous_multiplier) });
      rows.push({ label: 'بعد', value: pct(params.multiplier) });
    }
    if (params.status !== undefined) rows.push({ label: 'الحالة', value: params.status === 'PAUSED' ? 'إيقاف مؤقت' : 'تشغيل' });
  }
  return rows;
}
