import {
  MAX_CALLOUTS_PER_ACTION,
  MAX_REPLACEMENTS_PER_ACTION,
  MAX_SITELINKS_PER_ACTION,
  MAX_SNIPPET_VALUES,
  MIN_CALLOUTS_PER_ACTION,
  MIN_SITELINKS_PER_ACTION,
  MIN_SNIPPET_VALUES,
  SNIPPET_HEADERS,
  type AdsStudioOperation,
} from './types';
import {
  buildGrounding,
  sameMeaning,
  validateAssetText,
  validateCandidateSet,
  extractNumbers,
  normalizeText,
  type AdLanguage,
  type AssetTextKind,
  type Grounding,
} from '../validators';

/**
 * Pure payload validators for the ad-assets actions. Same contract as
 * lib/ai/extended-actions/validate.ts: they return the canonical target_id and
 * params to store and execute (built from a whitelist, so a stored payload can
 * never carry `resolved`), or a short refusal code. Nothing here talks to Google.
 *
 * At approval time only the rules that do not need the original sources run
 * in full (length, dashes, phone numbers, punctuation, symbols, language, AI
 * phrases, duplicates). Numbers are checked against `grounding_terms` that the
 * writer stored with the card; claim words were checked when the text was
 * written.
 */

export type StudioValidation =
  | { ok: true; target_id: string; params: Record<string, unknown> }
  | { ok: false; code: string };

const bad = (code: string): StudioValidation => ({ ok: false, code });

function resourceIn(value: unknown, type: string, customerId?: string | null): value is string {
  if (typeof value !== 'string') return false;
  const cid = customerId ? customerId.replace(/\D/g, '') : '\\d+';
  if (customerId && !cid) return false;
  return new RegExp(`^customers/${cid}/${type}/[^/]+$`).test(value);
}

const MAX_GROUNDING_TERMS = 80;

function cleanGroundingTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const t = item.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_GROUNDING_TERMS) break;
  }
  return out;
}

/** The words and numbers the writer was allowed to quote, stored with the card. */
export function groundingTermsFrom(sources: ReadonlyArray<string | null | undefined>): string[] {
  const g = buildGrounding(sources);
  const terms: string[] = [...g.numbers];
  for (const w of g.latinWords) terms.push(w);
  for (const w of g.capsWords) terms.push(w.toUpperCase());
  return cleanGroundingTerms(terms);
}

function language(value: unknown): AdLanguage | null {
  return value === 'ar' || value === 'en' ? value : null;
}

function groundingFor(terms: string[]): Grounding {
  // Latin terms keep their original case so capitals written in the sources stay allowed.
  return buildGrounding(terms);
}

/** Full text rules for stored copy. `grounding` limits numbers; claim words were checked by the writer. */
export function checkStoredText(
  text: unknown,
  kind: AssetTextKind,
  lang: AdLanguage,
  grounding: Grounding
): { ok: true; text: string } | { ok: false; code: string } {
  const checked = validateAssetText(text, kind, { language: lang, grounding, keepExisting: true });
  if (!checked.ok) return { ok: false, code: checked.code };
  for (const n of extractNumbers(checked.text)) {
    if (!grounding.numbers.has(n)) return { ok: false, code: 'invented_number' };
  }
  return { ok: true, text: checked.text };
}

function cleanList(
  value: unknown,
  kind: AssetTextKind,
  lang: AdLanguage,
  grounding: Grounding,
  min: number,
  max: number
): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  const out: string[] = [];
  for (const raw of value) {
    const checked = checkStoredText(raw, kind, lang, grounding);
    if (!checked.ok) return null;
    out.push(checked.text);
  }
  const report = validateCandidateSet(out, kind, { language: lang, grounding, keepExisting: true }, []);
  if (report.accepted.length !== out.length) return null;
  return out;
}

export function cleanHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
  if (/[\s<>"'`]/.test(value)) return null;
  return url.toString();
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** A Saudi mobile (5xxxxxxxx) or landline (1[1-7]xxxxxxx) number, canonical +966 form. */
export function cleanSaudiPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[\s\-().]/g, '');
  const m = /^(?:\+?966|00966|0)?(5\d{8}|1[1-7]\d{7})$/.exec(digits);
  return m ? `+966${m[1]}` : null;
}

export function validateAdsStudioPayload(
  operation: AdsStudioOperation,
  _targetId: string,
  paramsInput: unknown,
  accountCustomerId?: string | null
): StudioValidation {
  const params = paramsInput && typeof paramsInput === 'object' ? (paramsInput as Record<string, unknown>) : {};
  const lang = language(params.language) ?? 'ar';
  const terms = cleanGroundingTerms(params.grounding_terms);
  const grounding = groundingFor(terms);
  const campaign = String(params.campaign_resource ?? '');

  switch (operation) {
    case 'replace_rsa_assets': {
      const ad = String(params.ad_group_ad_resource ?? '');
      if (!resourceIn(ad, 'adGroupAds', accountCustomerId)) return bad('ad_invalid');
      const mode = params.mode === 'test_variant' ? 'test_variant' : params.mode === 'swap' || params.mode === undefined ? 'swap' : null;
      if (!mode) return bad('mode_invalid');
      const raw = params.replacements;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REPLACEMENTS_PER_ACTION) return bad('replacements_invalid');
      const replacements: Array<{ field: 'HEADLINE' | 'DESCRIPTION'; old_text: string; new_text: string }> = [];
      for (const item of raw) {
        const field = (item as any)?.field;
        const oldText = (item as any)?.old_text;
        if ((field !== 'HEADLINE' && field !== 'DESCRIPTION') || typeof oldText !== 'string' || !oldText.trim()) {
          return bad('replacements_invalid');
        }
        const checked = checkStoredText((item as any).new_text, field === 'HEADLINE' ? 'headline' : 'description', lang, grounding);
        if (!checked.ok) return bad(`text_${checked.code}`);
        if (normalizeText(oldText) === normalizeText(checked.text)) return bad('text_unchanged');
        replacements.push({ field, old_text: oldText.trim(), new_text: checked.text });
      }
      // New texts must not repeat each other (same field), and an old text is replaced once.
      for (const field of ['HEADLINE', 'DESCRIPTION'] as const) {
        const news = replacements.filter((r) => r.field === field).map((r) => r.new_text);
        const kind: AssetTextKind = field === 'HEADLINE' ? 'headline' : 'description';
        const report = validateCandidateSet(news, kind, { language: lang, grounding, keepExisting: true }, []);
        if (report.accepted.length !== news.length) return bad('replacements_duplicate');
        const olds = replacements.filter((r) => r.field === field).map((r) => r.old_text);
        if (new Set(olds).size !== olds.length) return bad('replacements_duplicate');
      }
      return {
        ok: true,
        target_id: ad,
        params: { ad_group_ad_resource: ad, mode, language: lang, replacements, grounding_terms: terms },
      };
    }

    case 'add_sitelinks': {
      if (!resourceIn(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const raw = params.sitelinks;
      if (!Array.isArray(raw) || raw.length < MIN_SITELINKS_PER_ACTION || raw.length > MAX_SITELINKS_PER_ACTION) {
        return bad('sitelinks_invalid');
      }
      const sitelinks: Array<{ final_url: string; link_text: string; description1: string; description2: string }> = [];
      const urls = new Set<string>();
      for (const item of raw) {
        const url = cleanHttpsUrl((item as any)?.final_url);
        if (!url || urls.has(url)) return bad('sitelink_url_invalid');
        const link = checkStoredText((item as any).link_text, 'sitelink_text', lang, grounding);
        const d1 = checkStoredText((item as any).description1, 'sitelink_description', lang, grounding);
        const d2 = checkStoredText((item as any).description2, 'sitelink_description', lang, grounding);
        if (!link.ok) return bad(`text_${link.code}`);
        if (!d1.ok) return bad(`text_${d1.code}`);
        if (!d2.ok) return bad(`text_${d2.code}`);
        if (sameMeaning(d1.text, d2.text)) return bad('sitelink_descriptions_same');
        urls.add(url);
        sitelinks.push({ final_url: url, link_text: link.text, description1: d1.text, description2: d2.text });
      }
      const linkReport = validateCandidateSet(sitelinks.map((s) => s.link_text), 'sitelink_text', { language: lang, grounding, keepExisting: true }, []);
      if (linkReport.accepted.length !== sitelinks.length) return bad('sitelinks_duplicate');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, sitelinks, language: lang, grounding_terms: terms } };
    }

    case 'add_callouts': {
      if (!resourceIn(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const callouts = cleanList(params.callouts, 'callout', lang, grounding, MIN_CALLOUTS_PER_ACTION, MAX_CALLOUTS_PER_ACTION);
      if (!callouts) return bad('callouts_invalid');
      return { ok: true, target_id: campaign, params: { campaign_resource: campaign, callouts, language: lang, grounding_terms: terms } };
    }

    case 'add_structured_snippet': {
      if (!resourceIn(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const header = String(params.header ?? '');
      if (!(SNIPPET_HEADERS as readonly string[]).includes(header)) return bad('snippet_header_invalid');
      const values = cleanList(params.values, 'snippet_value', lang, grounding, MIN_SNIPPET_VALUES, MAX_SNIPPET_VALUES);
      if (!values) return bad('snippet_values_invalid');
      return {
        ok: true,
        target_id: campaign,
        params: { campaign_resource: campaign, header, values, language: lang, grounding_terms: terms },
      };
    }

    case 'add_call_asset': {
      if (!resourceIn(campaign, 'campaigns', accountCustomerId)) return bad('campaign_invalid');
      const phone = cleanSaudiPhone(params.phone_number);
      if (!phone) return bad('phone_invalid');
      return {
        ok: true,
        target_id: campaign,
        params: { campaign_resource: campaign, country_code: 'SA', phone_number: phone },
      };
    }
  }
}
