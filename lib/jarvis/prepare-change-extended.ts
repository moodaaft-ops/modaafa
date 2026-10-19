import type { EvidenceRow } from './tools/types';
import { pctToModifier } from '@/lib/ai/extended-actions/validate';
import { DAYS_OF_WEEK, MAX_SHARED_LIST_KEYWORDS, MAX_ATTACH_CAMPAIGNS } from '@/lib/ai/extended-actions/types';
import { extendedPreviewRows } from '@/lib/ai/extended-actions/preview';

/**
 * prepare_change resolvers for the extended operations (EXTENDED_ACTIONS_ENABLED).
 * Same rule as the base operations: the model points at evidence refs and
 * non-numeric choices, the server builds every resource name from the rows.
 * Resolved shape matches `Resolved` in prepare-change.ts (injected helpers keep
 * this file free of an import cycle).
 */

export const EXTENDED_PREPARE_OPERATIONS = [
  'set_ad_schedule',
  'set_device_bid_modifier',
  'exclude_location',
  'set_location_bid_modifier',
  'set_geo_target_type',
  'set_network_settings',
  'create_shared_negative_list',
  'apply_google_recommendation',
  'dismiss_google_recommendation',
  'pause_auto_apply',
] as const;
export type ExtendedPrepareOperation = (typeof EXTENDED_PREPARE_OPERATIONS)[number];

export function isExtendedPrepareOperation(value: unknown): value is ExtendedPrepareOperation {
  return (EXTENDED_PREPARE_OPERATIONS as readonly string[]).includes(String(value));
}

export const EXTENDED_CHOICES_SCHEMA = {
  device: { type: 'string', enum: ['MOBILE', 'DESKTOP', 'TABLET'] },
  modifier_pct: { type: 'number', minimum: -100, maximum: 50 },
  geo_type: { type: 'string', enum: ['PRESENCE', 'PRESENCE_OR_INTEREST'] },
  networks: { type: 'array', items: { type: 'string', enum: ['search_partners', 'display'] }, maxItems: 2 },
  list_name: { type: 'string', maxLength: 60 },
  restrict_to_slots: { type: 'boolean' },
  slots: {
    type: 'array',
    maxItems: 42,
    items: {
      type: 'object',
      properties: {
        day_of_week: { type: 'string', enum: [...DAYS_OF_WEEK] },
        start_hour: { type: 'integer', minimum: 0, maximum: 23 },
        end_hour: { type: 'integer', minimum: 1, maximum: 24 },
        modifier_pct: { type: 'number', minimum: -50, maximum: 50 },
      },
      required: ['day_of_week', 'start_hour', 'end_hour'],
      additionalProperties: false,
    },
  },
} as const;

export const EXTENDED_TOOL_NOTE =
  ' Extended operations: set_ad_schedule: one cmp_ ref plus choices.slots (whole hours, modifier_pct -50 to 50) and ' +
  'optional restrict_to_slots. set_device_bid_modifier: one cmp_ ref plus choices.device and modifier_pct (-100 means ' +
  'exclude the device). exclude_location / set_location_bid_modifier: one cmp_ ref and one geo_ ref (modifier_pct for ' +
  'the second). set_geo_target_type: one cmp_ ref plus choices.geo_type. set_network_settings: one cmp_ ref plus ' +
  'choices.networks (search_partners, display), only turns them off. create_shared_negative_list: st_ or nw_ refs of ' +
  'wasted words plus 1 to 10 cmp_ refs to attach, choices.list_name. apply_google_recommendation: one gr_ ref with ' +
  'verdict accept. dismiss_google_recommendation: one gr_ ref with verdict reject. pause_auto_apply: one aa_ ref. ' +
  'Smart Bidding ignores schedule, device and location modifiers: do not propose them for such campaigns.';

type Helpers = {
  fail: (code: string, messageAr: string) => never;
  numberOf: (value: unknown) => number;
  text: (value: unknown, max?: number) => string;
};

export type ExtendedResolved = {
  payload: { operation: string; target_id: string; params: Record<string, unknown> };
  targetLabel: string;
  changes: string[];
  warnings: string[];
  evidence: Array<{ label: string; value: string }>;
  monthlyAmount: number;
  size: 'small' | 'large';
  sameTargetKey: string | null;
};

const SMART_NOTE = 'لو الحملة تستخدم مزايدة ذكية، قوقل تتجاهل هذا التعديل.';

function campaignRow(rows: EvidenceRow[], fail: Helpers['fail']): EvidenceRow {
  const campaigns = rows.filter((r) => r.kind === 'campaign');
  if (campaigns.length !== 1) fail('wrong_refs', 'هذي العملية تحتاج مرجع حملة واحد (cmp_).');
  return campaigns[0];
}

function onlyKinds(rows: EvidenceRow[], kinds: string[], fail: Helpers['fail']) {
  if (rows.some((r) => !kinds.includes(r.kind))) fail('wrong_refs', 'فيه مرجع ما يناسب هالعملية.');
}

function simple(
  operation: string,
  target: string,
  params: Record<string, unknown>,
  label: string,
  changes: string[],
  warnings: string[],
  evidence: Array<{ label: string; value: string }>,
  sameTargetKey: string | null
): ExtendedResolved {
  return {
    payload: { operation, target_id: target, params },
    targetLabel: label,
    changes,
    warnings,
    evidence,
    monthlyAmount: 0,
    size: 'large',
    sameTargetKey,
  };
}

export function resolveExtended(
  operation: ExtendedPrepareOperation,
  rows: EvidenceRow[],
  choices: Record<string, unknown>,
  h: Helpers
): ExtendedResolved {
  const { fail, numberOf, text } = h;

  switch (operation) {
    case 'set_ad_schedule': {
      onlyKinds(rows, ['campaign'], fail);
      const row = campaignRow(rows, fail);
      const resource = String(row.data.resource_name ?? '');
      const name = String(row.data.name ?? '');
      const rawSlots = Array.isArray(choices.slots) ? (choices.slots as Array<Record<string, unknown>>) : [];
      if (rawSlots.length === 0) fail('slots_required', 'حدد الفترات في choices.slots.');
      const slots = rawSlots.map((s) => ({
        day_of_week: String(s.day_of_week ?? ''),
        start_hour: numberOf(s.start_hour),
        start_minute: 'ZERO',
        end_hour: numberOf(s.end_hour),
        end_minute: 'ZERO',
        bid_modifier: s.modifier_pct === undefined ? 1 : pctToModifier(numberOf(s.modifier_pct)),
      }));
      const restrict = choices.restrict_to_slots === true;
      const warnings = [SMART_NOTE];
      if (restrict) warnings.push('الإعلانات تتوقف تماماً خارج هذي الفترات. تأكد إن العميل ما يفوته اتصال.');
      const params = { campaign_resource: resource, slots, restrict_to_slots: restrict };
      return simple(
        operation,
        resource,
        params,
        name,
        extendedPreviewRows(operation, params).map((r) => `${r.label}: ${r.value}`),
        warnings,
        [{ label: name, value: 'جدول العرض الحالي يُقرأ لحظة التنفيذ ويُحفظ للتراجع' }],
        resource
      );
    }

    case 'set_device_bid_modifier': {
      onlyKinds(rows, ['campaign', 'device'], fail);
      const row = campaignRow(rows, fail);
      const resource = String(row.data.resource_name ?? '');
      const name = String(row.data.name ?? '');
      const device = String(choices.device ?? '');
      if (!['MOBILE', 'DESKTOP', 'TABLET'].includes(device)) fail('device_required', 'حدد الجهاز في choices.device.');
      const pct = numberOf(choices.modifier_pct);
      if (!pct) fail('modifier_required', 'حدد نسبة التعديل في choices.modifier_pct.');
      const params = { campaign_resource: resource, device, bid_modifier: pct <= -100 ? 0 : pctToModifier(pct) };
      return simple(
        operation,
        resource,
        params,
        name,
        extendedPreviewRows(operation, params).slice(1).map((r) => `${r.label}: ${r.value}`),
        [SMART_NOTE, 'الاستبعاد الكامل يوقف الظهور على هذا الجهاز.'].slice(0, pct <= -100 ? 2 : 1),
        [{ label: name, value: `الجهاز ${device}` }],
        resource
      );
    }

    case 'exclude_location':
    case 'set_location_bid_modifier': {
      onlyKinds(rows, ['campaign', 'geo'], fail);
      const row = campaignRow(rows, fail);
      const geoRows = rows.filter((r) => r.kind === 'geo');
      if (geoRows.length !== 1) fail('wrong_refs', 'هذي العملية تحتاج مرجع موقع واحد (geo_).');
      const resource = String(row.data.resource_name ?? '');
      const name = String(row.data.name ?? '');
      const geo = String(geoRows[0].data.city_resource_name ?? '');
      const geoName = text(geoRows[0].data.name, 80) || geo;
      const params: Record<string, unknown> = { campaign_resource: resource, geo_target_constant: geo };
      const warnings: string[] = [];
      if (operation === 'set_location_bid_modifier') {
        const pct = numberOf(choices.modifier_pct);
        if (!pct || pct <= -100) fail('modifier_required', 'حدد نسبة التعديل (من -50 إلى 50) في choices.modifier_pct.');
        params.bid_modifier = pctToModifier(pct);
        warnings.push(SMART_NOTE);
      } else {
        warnings.push('الاستبعاد يمنع ظهور الإعلان لمن يبحث من هذا الموقع.');
      }
      return simple(
        operation,
        resource,
        params,
        name,
        [
          operation === 'exclude_location'
            ? `استبعاد «${geoName}» من حملة «${name}»`
            : `تعديل مزايدة «${geoName}» في حملة «${name}»`,
        ],
        warnings,
        [
          {
            label: geoName,
            value: `${numberOf(geoRows[0].data.cost)} صرف، ${numberOf(geoRows[0].data.conversions)} تحويل في الفترة`,
          },
        ],
        resource
      );
    }

    case 'set_geo_target_type': {
      onlyKinds(rows, ['campaign'], fail);
      const row = campaignRow(rows, fail);
      const resource = String(row.data.resource_name ?? '');
      const name = String(row.data.name ?? '');
      const type = String(choices.geo_type ?? '');
      if (!['PRESENCE', 'PRESENCE_OR_INTEREST'].includes(type)) fail('geo_type_required', 'حدد choices.geo_type.');
      const params = { campaign_resource: resource, positive_geo_target_type: type };
      return simple(
        operation,
        resource,
        params,
        name,
        [`استهداف حملة «${name}»: ${extendedPreviewRows(operation, params).slice(1)[0]?.value ?? ''}`],
        type === 'PRESENCE' ? ['الإعلان ما يظهر لمن يبحث عن منطقتك وهو خارجها.'] : [],
        [{ label: name, value: String(row.data.positive_geo_target_type ?? 'الإعداد الحالي يُقرأ لحظة التنفيذ') }],
        resource
      );
    }

    case 'set_network_settings': {
      onlyKinds(rows, ['campaign'], fail);
      const row = campaignRow(rows, fail);
      const resource = String(row.data.resource_name ?? '');
      const name = String(row.data.name ?? '');
      const networks = Array.isArray(choices.networks) ? (choices.networks as unknown[]).map(String) : [];
      if (networks.length === 0) fail('networks_required', 'حدد الشبكات في choices.networks.');
      const params: Record<string, unknown> = { campaign_resource: resource };
      if (networks.includes('search_partners')) params.target_search_network = false;
      if (networks.includes('display')) params.target_content_network = false;
      return simple(
        operation,
        resource,
        params,
        name,
        extendedPreviewRows(operation, params).slice(1).map((r) => `${r.label}: ${r.value}`),
        [],
        [{ label: name, value: 'الإعداد الحالي يُقرأ لحظة التنفيذ ويُحفظ للتراجع' }],
        resource
      );
    }

    case 'create_shared_negative_list': {
      onlyKinds(rows, ['search_term', 'negative_word', 'campaign'], fail);
      const campaignRows = rows.filter((r) => r.kind === 'campaign');
      const wordRows = rows.filter((r) => r.kind !== 'campaign');
      if (campaignRows.length === 0 || campaignRows.length > MAX_ATTACH_CAMPAIGNS) {
        fail('wrong_refs', 'اربط القائمة بحملة واحدة إلى عشر حملات (cmp_).');
      }
      if (wordRows.length === 0 || wordRows.length > MAX_SHARED_LIST_KEYWORDS) {
        fail('wrong_refs', 'حدد العبارات الضايعة بمراجعها (st_ أو nw_).');
      }
      const keywords: Array<{ text: string; match_type: string }> = [];
      for (const r of wordRows) {
        if (r.kind === 'search_term') {
          if (r.data.role !== 'waste' || numberOf(r.data.conversions) > 0) {
            fail('not_waste', `العبارة ${r.ref} جابت تحويل أو مو من العبارات الضايعة، ما تنمنع.`);
          }
          keywords.push({ text: String(r.data.term_raw ?? r.data.term ?? ''), match_type: 'PHRASE' });
        } else {
          keywords.push({ text: String(r.data.word ?? ''), match_type: 'PHRASE' });
        }
      }
      const name = text(choices.list_name, 60);
      if (!name) fail('list_name_required', 'حدد اسم القائمة في choices.list_name.');
      const campaigns = campaignRows.map((r) => String(r.data.resource_name ?? ''));
      const params = { name, keywords, campaign_resources: campaigns };
      return {
        payload: { operation, target_id: '', params },
        targetLabel: name,
        changes: [
          `قائمة «${name}» فيها ${keywords.length} كلمة سلبية (مطابقة عبارة)`,
          `تُربط بـ ${campaigns.length} حملة`,
        ],
        warnings: [
          'مطابقة العبارة تمنع أي بحث فيه هذي الكلمات.',
          'القوائم المشتركة ما تنربط تلقائي بحملات جديدة.',
          'نستبعد تلقائياً أي كلمة تمنع بحثاً جاب تحويل أو كلمة مفعّلة.',
        ],
        evidence: wordRows.map((r) => ({
          label: String(r.data.term ?? r.data.word ?? r.ref),
          value: `${numberOf(r.data.cost)} صرف بدون تحويل`,
        })),
        monthlyAmount: 0,
        size: 'large',
        sameTargetKey: null,
      };
    }

    case 'apply_google_recommendation':
    case 'dismiss_google_recommendation': {
      onlyKinds(rows, ['google_recommendation'], fail);
      if (rows.length !== 1) fail('wrong_refs', 'هذي العملية تحتاج مرجع توصية واحد (gr_).');
      const d = rows[0].data;
      const wantVerdict = operation === 'apply_google_recommendation' ? 'accept' : 'reject';
      if (d.verdict !== wantVerdict) {
        fail('verdict_mismatch', `هذي التوصية حكمها ${String(d.verdict)}، ما تنفع لهالعملية.`);
      }
      if (operation === 'apply_google_recommendation' && d.applicable !== true) {
        fail('not_appliable', 'هذا النوع من التوصيات ما نطبقه من المنصة.');
      }
      const resource = String(d.resource_name ?? '');
      const type = String(d.type ?? '');
      const params = { recommendation_resource: resource, recommendation_type: type };
      return simple(
        operation,
        resource,
        params,
        type,
        [String(d.reason_ar ?? '')],
        operation === 'apply_google_recommendation'
          ? ['التطبيق ما يرجع من المنصة. لو تبي تلغيه تحذف الإضافة من قوقل أدز.']
          : ['الرفض ما يرجع من المنصة، وقوقل ممكن تعيد اقتراحها لاحقاً.'],
        [{ label: type, value: String(d.campaign ?? 'على مستوى الحساب') }],
        null
      );
    }

    case 'pause_auto_apply': {
      onlyKinds(rows, ['auto_apply'], fail);
      if (rows.length !== 1) fail('wrong_refs', 'هذي العملية تحتاج مرجع التطبيق التلقائي (aa_).');
      const resources = Array.isArray(rows[0].data.subscription_resources)
        ? (rows[0].data.subscription_resources as unknown[]).map(String)
        : [];
      if (resources.length === 0) fail('nothing_enabled', 'ما فيه تطبيق تلقائي شغال.');
      const params = { subscription_resources: resources };
      return simple(
        operation,
        '',
        params,
        'التطبيق التلقائي',
        [`إيقاف التطبيق التلقائي لـ ${resources.length} نوع من التوصيات`],
        ['تقدر ترجّعه بزر التراجع.'],
        [{ label: 'الأنواع', value: (Array.isArray(rows[0].data.types) ? (rows[0].data.types as unknown[]) : []).map(String).join('، ') }],
        null
      );
    }
  }
}
