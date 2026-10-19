import type { EvidenceRow } from './tools/types';
import { ADS_STUDIO_OPERATIONS, MAX_CALLOUTS_PER_ACTION, MAX_REPLACEMENTS_PER_ACTION, MAX_SITELINKS_PER_ACTION, SNIPPET_HEADERS, type AdsStudioOperation } from '@/lib/ads/studio/types';
import { groundingTermsFrom, validateAdsStudioPayload } from '@/lib/ads/studio/validate';
import { detectAdLanguage } from '@/lib/ads/writer';
import { hostKey } from '@/lib/landing-check/site-pages';
import type { ExtendedResolved } from './prepare-change-extended';

/**
 * prepare_change for the Ads Studio actions (ADS_STUDIO_ENABLED and
 * EXTENDED_ACTIONS_ENABLED). Same rule as every operation: the model points at
 * evidence refs and writes only the words; the server takes every resource
 * name, URL and phone number from the evidence rows.
 *
 *   replace_rsa_assets      one rsa_ad ref, choices.replacements [{n, new_text}] where n is the number
 *                           of a text listed in that ad's `replaceable_texts` (LOW with 1000+ impressions
 *                           or disapproved; never a text the rules would not touch)
 *   add_callouts            one cmp_ ref, choices.callouts
 *   add_structured_snippet  one cmp_ ref, choices.header and choices.values
 *   add_sitelinks           one cmp_ ref plus sp_ refs (site pages the landing check crawl saw answer 200
 *                           on the merchant's own host), choices.sitelinks [{page_ref, link_text, description1, description2}]
 *   add_call_asset          one cmp_ ref plus one ph_ ref (a number the merchant gave us or that already
 *                           serves in the account). The model never types a number.
 *
 * Text checks are the validators of lib/ads/validators.ts (limits, dashes,
 * invented numbers, AI phrases), run again at approval and at execution.
 */

export const ADS_STUDIO_PREPARE_OPERATIONS = ADS_STUDIO_OPERATIONS;

export function isAdsStudioPrepareOperation(value: unknown): value is AdsStudioOperation {
  return (ADS_STUDIO_PREPARE_OPERATIONS as readonly string[]).includes(String(value));
}

export const ADS_STUDIO_CHOICES_SCHEMA = {
  replacements: {
    type: 'array',
    maxItems: MAX_REPLACEMENTS_PER_ACTION,
    items: {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 1, maximum: 12 }, new_text: { type: 'string', maxLength: 90 } },
      required: ['n', 'new_text'],
      additionalProperties: false,
    },
  },
  callouts: { type: 'array', maxItems: MAX_CALLOUTS_PER_ACTION, items: { type: 'string', maxLength: 25 } },
  header: { type: 'string', enum: [...SNIPPET_HEADERS] },
  values: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 25 } },
  sitelinks: {
    type: 'array',
    maxItems: MAX_SITELINKS_PER_ACTION,
    items: {
      type: 'object',
      properties: {
        page_ref: { type: 'string', pattern: '^sp_[0-9]{1,4}$' },
        link_text: { type: 'string', maxLength: 25 },
        description1: { type: 'string', maxLength: 35 },
        description2: { type: 'string', maxLength: 35 },
      },
      required: ['page_ref', 'link_text', 'description1', 'description2'],
      additionalProperties: false,
    },
  },
} as const;

export const ADS_STUDIO_TOOL_NOTE =
  ' Ad copy operations: replace_rsa_assets: one rsa_ad ref plus choices.replacements [{n, new_text}] (n is the number in ' +
  "that ad's replaceable_texts; only those texts can be replaced). add_callouts: one cmp_ ref plus choices.callouts (2 to 6 " +
  'short items). add_structured_snippet: one cmp_ ref plus choices.header and choices.values (3 or more). add_sitelinks: one ' +
  'cmp_ ref plus 2 to 6 sp_ refs from get_landing_check and choices.sitelinks [{page_ref, link_text, description1, description2}]. ' +
  'add_call_asset: one cmp_ ref plus the ph_ ref from get_ad_assets (never type a number). Write only from facts in the evidence: ' +
  'no numbers, offers or claims you did not read.';

type Helpers = {
  fail: (code: string, messageAr: string) => never;
  numberOf: (value: unknown) => number;
  text: (value: unknown, max?: number) => string;
};

function only(rows: EvidenceRow[], kind: string, fail: Helpers['fail'], messageAr: string): EvidenceRow {
  const found = rows.filter((r) => r.kind === kind);
  if (found.length !== 1) fail('wrong_refs', messageAr);
  return found[0];
}

function onlyKinds(rows: EvidenceRow[], kinds: string[], fail: Helpers['fail']) {
  if (rows.some((r) => !kinds.includes(r.kind))) fail('wrong_refs', 'فيه مرجع ما يناسب هالعملية.');
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function checked(operation: AdsStudioOperation, target: string, params: Record<string, unknown>, customerId: string, fail: Helpers['fail']) {
  const result = validateAdsStudioPayload(operation, target, params, customerId);
  if (!result.ok) fail('text_rejected', `النص ما عدّى فحص الجودة (${result.code}). اكتب نص أقصر وأبسط من كلام الإعلان نفسه، بدون أرقام جديدة.`);
  return result;
}

export function resolveAdsStudio(
  operation: AdsStudioOperation,
  rows: EvidenceRow[],
  choices: Record<string, unknown>,
  h: Helpers & { customerId: string }
): ExtendedResolved {
  const { fail, text, customerId } = h;
  const base = { monthlyAmount: 0, size: 'large' as const, sameTargetKey: null };

  if (operation === 'replace_rsa_assets') {
    onlyKinds(rows, ['rsa_ad'], fail);
    const row = only(rows, 'rsa_ad', fail, 'هذي العملية تحتاج مرجع إعلان واحد (rsa_).');
    const verdict: any = row.data.verdict ?? {};
    const candidates: Array<{ text: string; field: 'HEADLINE' | 'DESCRIPTION'; reason: string }> = list(verdict.replace) as any;
    if (candidates.length === 0) fail('nothing_replaceable', 'الإعلان هذا ما فيه نصوص تنطبق عليها قاعدة التبديل (ضعيفة بعد 1000 ظهور أو مرفوضة).');
    const wanted = list(choices.replacements) as Array<Record<string, unknown>>;
    if (wanted.length === 0) fail('replacements_required', 'حدد البدائل في choices.replacements.');
    const used = new Set<number>();
    const replacements: Array<{ field: string; old_text: string; new_text: string }> = [];
    for (const item of wanted) {
      const n = Number(item?.n);
      if (!Number.isInteger(n) || n < 1 || n > candidates.length || used.has(n)) {
        fail('bad_replacement_number', 'رقم النص المراد تبديله مو من القايمة replaceable_texts.');
      }
      used.add(n);
      const candidate = candidates[n - 1];
      replacements.push({ field: candidate.field, old_text: candidate.text, new_text: text(item?.new_text, 90) });
    }
    const sources = [
      row.data.campaign,
      row.data.ad_group,
      ...list((row.data.best as any)?.headlines).map((x: any) => x?.text),
      ...list((row.data.best as any)?.descriptions).map((x: any) => x?.text),
      ...candidates.map((c) => c.text),
    ] as string[];
    const language = detectAdLanguage(sources);
    const params = {
      ad_group_ad_resource: String(row.data.ad_group_ad ?? ''),
      mode: 'swap',
      language,
      replacements,
      grounding_terms: groundingTermsFrom(sources),
    };
    const result = checked('replace_rsa_assets', params.ad_group_ad_resource, params, customerId, fail);
    const adName = String(row.data.ad_group ?? row.data.campaign ?? '');
    return {
      payload: { operation, target_id: result.target_id, params: result.params },
      targetLabel: adName,
      changes: replacements.map((r) => `تبديل «${r.old_text}» بـ «${r.new_text}»`),
      warnings: ['الإعلان الحالي يبقى محفوظ وتقدر ترجعه بزر التراجع.'],
      evidence: [{ label: adName, value: `${replacements.length} نص من ${candidates.length} نص تنطبق عليه قاعدة التبديل` }],
      ...base,
    };
  }

  // The rest are campaign-level.
  const campaignRows = rows.filter((r) => r.kind === 'campaign');
  if (campaignRows.length !== 1) fail('wrong_refs', 'هذي العملية تحتاج مرجع حملة واحد (cmp_).');
  const campaign = campaignRows[0];
  const resource = String(campaign.data.resource_name ?? '');
  const name = String(campaign.data.name ?? '');
  const sources = [name];

  if (operation === 'add_callouts') {
    onlyKinds(rows, ['campaign'], fail);
    const callouts = list(choices.callouts).map((c) => text(c, 25)).filter(Boolean);
    const language = detectAdLanguage([...callouts, name]);
    const params = { campaign_resource: resource, callouts, language, grounding_terms: groundingTermsFrom(sources) };
    const result = checked(operation, resource, params, customerId, fail);
    return {
      payload: { operation, target_id: result.target_id, params: result.params },
      targetLabel: name,
      changes: callouts.map((c) => `إضافة النص المميز «${c}» لحملة «${name}»`),
      warnings: [],
      evidence: [{ label: name, value: `${callouts.length} نص مميز` }],
      ...base,
    };
  }

  if (operation === 'add_structured_snippet') {
    onlyKinds(rows, ['campaign'], fail);
    const header = text(choices.header, 40);
    const values = list(choices.values).map((v) => text(v, 25)).filter(Boolean);
    const language = detectAdLanguage([...values, name]);
    const params = { campaign_resource: resource, header, values, language, grounding_terms: groundingTermsFrom(sources) };
    const result = checked(operation, resource, params, customerId, fail);
    return {
      payload: { operation, target_id: result.target_id, params: result.params },
      targetLabel: name,
      changes: [`إضافة مقتطف منظم (${header}): ${values.join('، ')}`],
      warnings: [],
      evidence: [{ label: name, value: `${values.length} قيمة` }],
      ...base,
    };
  }

  if (operation === 'add_sitelinks') {
    onlyKinds(rows, ['campaign', 'site_page'], fail);
    const pages = new Map(rows.filter((r) => r.kind === 'site_page').map((r) => [r.ref, r] as const));
    if (pages.size === 0) fail('site_pages_required', 'الروابط الفرعية تحتاج صفحات من فحص الموقع (sp_) في evidence_refs. شغّل get_landing_check أول.');
    const wanted = list(choices.sitelinks) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    const sitelinks: Array<Record<string, string>> = [];
    for (const item of wanted) {
      const ref = String(item?.page_ref ?? '');
      const page = pages.get(ref);
      if (!page || seen.has(ref)) fail('unknown_page_ref', 'صفحة الرابط الفرعي لازم تكون من مراجع sp_ اللي في evidence_refs.');
      seen.add(ref);
      sitelinks.push({
        final_url: String(page!.data.url ?? ''),
        link_text: text(item?.link_text, 25),
        description1: text(item?.description1, 35),
        description2: text(item?.description2, 35),
      });
    }
    const hosts = new Set(sitelinks.map((s) => hostKey(s.final_url)));
    if (hosts.size !== 1 || hosts.has(null)) fail('mixed_hosts', 'كل الروابط الفرعية لازم تكون من موقع واحد.');
    const pageTexts = [...pages.values()].flatMap((p) => [String(p.data.title ?? ''), String(p.data.h1 ?? '')]);
    const language = detectAdLanguage([...sitelinks.map((s) => s.link_text), name, ...pageTexts]);
    const params = { campaign_resource: resource, sitelinks, language, grounding_terms: groundingTermsFrom([name, ...pageTexts]) };
    const result = checked(operation, resource, params, customerId, fail);
    return {
      payload: { operation, target_id: result.target_id, params: result.params },
      targetLabel: name,
      changes: sitelinks.map((s) => `رابط فرعي «${s.link_text}» يفتح ${s.final_url}`),
      warnings: [],
      evidence: sitelinks.map((s) => ({ label: s.link_text, value: s.final_url })),
      ...base,
    };
  }

  // add_call_asset
  onlyKinds(rows, ['campaign', 'verified_phone'], fail);
  const phone = rows.filter((r) => r.kind === 'verified_phone');
  if (phone.length !== 1) fail('phone_not_verified', 'ما عندنا رقم موثق للاتصال. لازم رقم سجله العميل أو شغال أصلاً في حسابه (ph_). لا تكتب رقم بنفسك.');
  const number = String(phone[0].data.phone ?? '');
  const params = { campaign_resource: resource, phone_number: number };
  const result = checked(operation, resource, params, customerId, fail);
  const where = phone[0].data.source === 'merchant_saved' ? 'رقم سجله العميل عندنا' : 'رقم اتصال شغال أصلاً في حسابه';
  return {
    payload: { operation, target_id: result.target_id, params: result.params },
    targetLabel: name,
    changes: [`إضافة زر اتصال برقم ${number} لحملة «${name}»`],
    warnings: [],
    evidence: [{ label: 'مصدر الرقم', value: where }],
    ...base,
  };
}
