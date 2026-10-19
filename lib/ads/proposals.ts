import { actionFingerprint, categoryForAction, severityForAction } from '../ai/action-fingerprint';
import {
  assetVerdict,
  buildAdAssetsSnapshot,
  readExtensionCoverage,
  readRsaAssets,
  type AdAssetReport,
  type AdAssetsSnapshot,
  type CampaignCoverage,
  type GaqlReader,
  type RsaSummary,
} from './assets-reader';
import { esc, list, str } from './rows';
import { validateAdsStudioPayload, groundingTermsFrom } from './studio/validate';
import {
  detectAdLanguage,
  groundingFor,
  writeCallouts,
  writeRsaReplacements,
  writeSnippetValues,
  type ConvertingTerm,
  type WriterBusiness,
  type WriterDeps,
} from './writer';

/**
 * The optimizer's ad copy cards. Two kinds only, both queued for approval and
 * never executed by autopilot:
 *
 *   replace LOW assets   a responsive ad whose texts Google rates LOW (1000+
 *                        impressions) gets a card with new texts from the
 *                        writer, every one validated;
 *   add missing assets   a Search campaign without callouts or a structured
 *                        snippet gets a card with them (sitelinks and a call
 *                        asset only when the caller supplies real site urls or
 *                        the merchant's phone, which the platform does not
 *                        hold today).
 *
 * Rules, not a model, decide WHICH cards exist. The model is only asked for
 * words, after the dedupe check, so an already-pending card costs nothing.
 * At most one card of each kind per account per run.
 */

export type AssetCard = {
  kind: 'replace_low' | 'add_missing';
  fingerprint: string;
  action: {
    type: 'replace_rsa_assets' | 'add_callouts' | 'add_structured_snippet' | 'add_sitelinks' | 'add_call_asset';
    target_id: string;
    params: Record<string, unknown>;
    reason_ar: string;
    reason_en: string;
    expected_impact: { metric: string; delta_pct: number; delta_sar_per_month: number };
  };
};

export type ProposalInput = {
  accountId: string;
  customerId: string;
  report: AdAssetReport;
  coverage: readonly CampaignCoverage[] | null;
  /** Read side used to avoid proposing an asset the campaign already has. */
  reader: GaqlReader;
  business: WriterBusiness;
  topTerms: readonly ConvertingTerm[];
  landing?: { title?: string | null; h1?: string | null } | null;
};

export type ProposalDeps = {
  writer: WriterDeps;
  /** True when a pending, approved or dismissed card with this fingerprint exists. */
  hasBlocking(fingerprint: string): Promise<boolean>;
};

export type ProposalReport = { cards: AssetCard[]; skipped: Array<{ what: string; why: string }> };

const NOW_IMPACT = { metric: 'ad_strength', delta_pct: 0, delta_sar_per_month: 0 };

/** The identity of a replace card: the ad and the exact texts it would replace. Not the new words. */
export function replaceFingerprint(accountId: string, adGroupAd: string, replace: ReadonlyArray<{ field: string; text: string }>) {
  return actionFingerprint(accountId, {
    type: 'replace_rsa_assets',
    target_id: adGroupAd,
    params: { replace: replace.map((r) => `${r.field}|${r.text}`).sort() },
  });
}

export function addFingerprint(accountId: string, type: string, campaign: string) {
  return actionFingerprint(accountId, { type, target_id: campaign, params: {} });
}

function keepTexts(rsa: RsaSummary, replaced: ReadonlySet<string>) {
  const all = [...rsa.headlines, ...rsa.descriptions].filter((a) => !replaced.has(`${a.field}|${a.text}`));
  const rank = (label: string) => (label === 'BEST' ? 0 : label === 'GOOD' ? 1 : 2);
  return all.sort((a, b) => rank(a.label) - rank(b.label)).map((a) => ({ text: a.text, field: a.field, label: a.label }));
}

async function replaceCard(input: ProposalInput, deps: ProposalDeps, skipped: ProposalReport['skipped']): Promise<AssetCard | null> {
  const ranked = input.report.rsas
    .map((rsa) => ({ rsa, verdict: assetVerdict(rsa) }))
    .filter((x) => x.verdict.replace.length > 0)
    .sort((a, b) => b.verdict.replace.length - a.verdict.replace.length || b.rsa.impressions_30d - a.rsa.impressions_30d);

  for (const { rsa, verdict } of ranked) {
    const fingerprint = replaceFingerprint(input.accountId, rsa.ad_group_ad, verdict.replace);
    if (await deps.hasBlocking(fingerprint)) {
      skipped.push({ what: 'replace_rsa_assets', why: 'card_exists' });
      continue;
    }
    const replacedKeys = new Set(verdict.replace.map((r) => `${r.field}|${r.text}`));
    const keep = keepTexts(rsa, replacedKeys);
    const language = detectAdLanguage([...keep.map((k) => k.text), input.landing?.title, input.landing?.h1]);
    const ctx = { language, business: input.business, topTerms: input.topTerms, landing: input.landing ?? null };

    const written = await writeRsaReplacements({ ...ctx, replace: verdict.replace, keep }, deps.writer);
    if (!written.ok) {
      skipped.push({ what: 'replace_rsa_assets', why: written.code });
      continue;
    }

    const pairs: Array<{ field: 'HEADLINE' | 'DESCRIPTION'; old_text: string; new_text: string }> = [];
    const heads = [...written.headlines];
    const descs = [...written.descriptions];
    for (const r of verdict.replace) {
      const next = r.field === 'HEADLINE' ? heads.shift() : descs.shift();
      if (next) pairs.push({ field: r.field, old_text: r.text, new_text: next });
    }
    if (pairs.length === 0) continue;

    const grounding = groundingFor(ctx, keep.map((k) => k.text));
    const validated = validateAdsStudioPayload('replace_rsa_assets', rsa.ad_group_ad, {
      ad_group_ad_resource: rsa.ad_group_ad,
      mode: 'swap',
      language,
      replacements: pairs,
      grounding_terms: groundingTermsFrom([...grounding.numbers, ...grounding.latinWords, ...keep.map((k) => k.text)]),
    }, input.customerId);
    if (!validated.ok) {
      skipped.push({ what: 'replace_rsa_assets', why: validated.code });
      continue;
    }
    const lowCount = pairs.length;
    const name = rsa.ad_group_name || rsa.campaign_name;
    const reason_ar = `قوقل مقيّم ${lowCount} من نصوص إعلان "${name}" ضعيف. جهزنا بدايل، والإعلان الحالي يبقى متوقف ومحفوظ وتقدر ترجعه.`;
    return {
      kind: 'replace_low',
      fingerprint,
      action: {
        type: 'replace_rsa_assets',
        target_id: validated.target_id,
        params: validated.params,
        reason_ar,
        reason_en: `Replace ${lowCount} LOW-rated responsive search ad text(s) in ${name}`,
        expected_impact: NOW_IMPACT,
      },
    };
  }
  return null;
}

async function existingCampaignTexts(reader: GaqlReader, campaign: string, field: 'CALLOUT' | 'STRUCTURED_SNIPPET'): Promise<string[]> {
  const rows = await reader.query(`
    SELECT asset.callout_asset.callout_text, asset.structured_snippet_asset.values
    FROM campaign_asset
    WHERE campaign_asset.campaign = '${esc(campaign)}' AND campaign_asset.field_type = '${field}'
      AND campaign_asset.status != 'REMOVED'
    LIMIT 100
  `);
  const out: string[] = [];
  for (const row of rows) {
    const callout = str(row, 'asset.callout_asset.callout_text');
    if (callout) out.push(callout);
    for (const v of list(row, 'asset.structured_snippet_asset.values')) if (typeof v === 'string') out.push(v);
  }
  return out;
}

async function addCard(input: ProposalInput, deps: ProposalDeps, skipped: ProposalReport['skipped']): Promise<AssetCard | null> {
  const needing = (input.coverage ?? []).filter((c) => c.missing.length > 0);
  if (needing.length === 0) return null;

  // The campaign that serves the most; its ads are also the source of what may be said.
  const impressions = (campaign: string) =>
    input.report.rsas.filter((r) => r.campaign === campaign).reduce((sum, r) => sum + r.impressions_30d, 0);
  const ordered = [...needing].sort((a, b) => impressions(b.campaign) - impressions(a.campaign));

  for (const cov of ordered) {
    if (impressions(cov.campaign) === 0) continue;
    // What the merchant already says in the ads that run here is what the new assets may say.
    const adTexts = input.report.rsas
      .filter((r) => r.campaign === cov.campaign && r.status === 'ENABLED')
      .flatMap((r) => [...r.headlines, ...r.descriptions])
      .filter((a) => a.label === 'BEST' || a.label === 'GOOD' || a.label === 'UNKNOWN' || a.label === 'LEARNING')
      .map((a) => a.text);
    if (adTexts.length < 4) continue;
    const language = detectAdLanguage([...adTexts, input.landing?.title]);
    const ctx = {
      language,
      business: input.business,
      topTerms: input.topTerms,
      landing: input.landing ?? null,
      extraGrounding: adTexts.slice(0, 10),
    };

    if (cov.missing.includes('CALLOUT')) {
      const fingerprint = addFingerprint(input.accountId, 'add_callouts', cov.campaign);
      if (await deps.hasBlocking(fingerprint)) {
        skipped.push({ what: 'add_callouts', why: 'card_exists' });
        continue;
      }
      const existing = await existingCampaignTexts(input.reader, cov.campaign, 'CALLOUT');
      const written = await writeCallouts(ctx, deps.writer, 4, existing);
      if (written.ok && written.texts.length >= 2) {
        const grounding = groundingFor(ctx, existing);
        const validated = validateAdsStudioPayload('add_callouts', cov.campaign, {
          campaign_resource: cov.campaign,
          callouts: written.texts,
          language,
          grounding_terms: groundingTermsFrom([...grounding.numbers, ...grounding.latinWords]),
        }, input.customerId);
        if (validated.ok) {
          return {
            kind: 'add_missing',
            fingerprint,
            action: {
              type: 'add_callouts',
              target_id: validated.target_id,
              params: validated.params,
              reason_ar: `حملة "${cov.campaign_name}" ما فيها نصوص مميزة كفاية. جهزنا ${written.texts.length} من كلام إعلاناتك نفسها.`,
              reason_en: `Add callouts to ${cov.campaign_name}`,
              expected_impact: { metric: 'ctr', delta_pct: 0, delta_sar_per_month: 0 },
            },
          };
        }
        skipped.push({ what: 'add_callouts', why: validated.code });
      } else {
        skipped.push({ what: 'add_callouts', why: written.ok ? 'too_few' : written.code });
      }
    }

    if (cov.missing.includes('STRUCTURED_SNIPPET')) {
      const fingerprint = addFingerprint(input.accountId, 'add_structured_snippet', cov.campaign);
      if (await deps.hasBlocking(fingerprint)) {
        skipped.push({ what: 'add_structured_snippet', why: 'card_exists' });
        continue;
      }
      const existing = await existingCampaignTexts(input.reader, cov.campaign, 'STRUCTURED_SNIPPET');
      const written = await writeSnippetValues(ctx, deps.writer, 5, existing);
      if (written.ok && written.texts.length >= 3) {
        const grounding = groundingFor(ctx, existing);
        const validated = validateAdsStudioPayload('add_structured_snippet', cov.campaign, {
          campaign_resource: cov.campaign,
          header: 'Service catalog',
          values: written.texts,
          language,
          grounding_terms: groundingTermsFrom([...grounding.numbers, ...grounding.latinWords]),
        }, input.customerId);
        if (validated.ok) {
          return {
            kind: 'add_missing',
            fingerprint,
            action: {
              type: 'add_structured_snippet',
              target_id: validated.target_id,
              params: validated.params,
              reason_ar: `حملة "${cov.campaign_name}" ما فيها مقتطف منظم للخدمات. جهزنا ${written.texts.length} قيم من كلام إعلاناتك.`,
              reason_en: `Add a structured snippet to ${cov.campaign_name}`,
              expected_impact: { metric: 'ctr', delta_pct: 0, delta_sar_per_month: 0 },
            },
          };
        }
        skipped.push({ what: 'add_structured_snippet', why: validated.code });
      } else {
        skipped.push({ what: 'add_structured_snippet', why: written.ok ? 'too_few' : written.code });
      }
    }

    // Sitelinks need real pages of the merchant's site and a call asset needs the merchant's own
    // number. The platform holds neither today, so no card is invented for them.
    if (cov.missing.includes('SITELINK')) skipped.push({ what: 'add_sitelinks', why: 'no_site_urls' });
    if (cov.missing.includes('CALL')) skipped.push({ what: 'add_call_asset', why: 'no_phone_number' });
  }
  return null;
}

/** At most one replace card and one add card. Never throws: a failed part is reported as skipped. */
export async function buildAssetProposals(input: ProposalInput, deps: ProposalDeps): Promise<ProposalReport> {
  const cards: AssetCard[] = [];
  const skipped: ProposalReport['skipped'] = [];
  for (const step of [replaceCard, addCard]) {
    try {
      const card = await step(input, deps, skipped);
      if (card) cards.push(card);
    } catch (error) {
      skipped.push({ what: step.name, why: error instanceof Error ? error.message.slice(0, 80) : 'failed' });
    }
  }
  return { cards, skipped };
}

// ---------------------------------------------------------------------------
// Cron glue
// ---------------------------------------------------------------------------

export type AdsStudioRead = { report: AdAssetReport; coverage: CampaignCoverage[] | null; block: AdAssetsSnapshot };

/** Reads the assets once; the block goes into the optimizer snapshot, the rest feeds the cards. */
export async function collectAdsStudioRead(customer: GaqlReader): Promise<AdsStudioRead | null> {
  const report = await readRsaAssets(customer);
  if (!report.readable) return null;
  const coverage = await readExtensionCoverage(customer);
  return { report, coverage, block: buildAdAssetsSnapshot(report, coverage) };
}

/** Only these setup answers describe the business to the public: name, type and where it works. */
const PUBLIC_SETUP_KEYS = ['type', 'name', 'regions'] as const;

export async function loadBusinessFacts(admin: any, businessId: string | null | undefined): Promise<string[]> {
  if (!admin || !businessId) return [];
  try {
    const { data, error } = await admin
      .from('business_memory')
      .select('fact_ar, data')
      .eq('business_id', businessId)
      .eq('source', 'onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(60);
    if (error || !Array.isArray(data)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of data) {
      const key = row?.data?.setup_key;
      if (typeof key !== 'string' || !(PUBLIC_SETUP_KEYS as readonly string[]).includes(key) || seen.has(key)) continue;
      seen.add(key);
      if (typeof row.fact_ar === 'string' && row.fact_ar.trim()) out.push(row.fact_ar.trim().slice(0, 200));
    }
    return out;
  } catch {
    return [];
  }
}

export type QueueRow = {
  category: string;
  severity: string;
  title: string;
  description: string;
  expected_impact: Record<string, unknown>;
  action_payload: Record<string, unknown>;
};

export function cardToRow(card: AssetCard): QueueRow {
  const { action } = card;
  return {
    category: categoryForAction(action.type),
    severity: severityForAction(action),
    title: action.reason_ar.slice(0, 120),
    description: action.reason_ar,
    expected_impact: action.expected_impact,
    action_payload: {
      operation: action.type,
      target_id: action.target_id,
      params: action.params,
      confidence: null,
      evidence: null,
      source: 'optimizer_cron',
      // A card for the owner, never an autopilot execution.
      autopilot: { outcome: 'queue', code: 'ads_studio_manual_only' },
    },
  };
}

/**
 * Inserts the cards as pending recommendations. A fingerprint collision (23505)
 * means the card already exists and is left alone.
 */
export async function queueAssetCards(supabase: any, accountId: string, cards: readonly AssetCard[]): Promise<number> {
  let created = 0;
  for (const card of cards) {
    const { error } = await supabase
      .from('recommendations')
      .insert({ account_id: accountId, fingerprint: card.fingerprint, ...cardToRow(card), status: 'pending' });
    if (!error) created += 1;
    else if (error.code !== '23505') throw error;
  }
  return created;
}
