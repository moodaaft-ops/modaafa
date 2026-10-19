import type { EvidenceRow, JarvisReadTool } from './types';
import { cleanText, okResult, parseArgs, refCounter } from './shared';
import {
  assetVerdict,
  readAssetGroups,
  readExtensionCoverage,
  readRsaAssets,
  type RsaSummary,
} from '@/lib/ads/assets-reader';
import { readAdTests } from '@/lib/ads/ad-test';
import { readAccountCallPhones, readMerchantSavedPhones, resolveVerifiedPhone, type PhoneResolution } from '@/lib/ads/site-sources';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * What each responsive search ad is made of and how Google rates every text
 * (BEST, GOOD, LOW, LEARNING, PENDING), the ad strength, policy problems per
 * text, which Search campaigns lack sitelinks, callouts, snippets or a call
 * asset, and the state of any A/B test between two ads. Registered only when
 * ADS_STUDIO_ENABLED is on. Read only.
 *
 * Resource names stay in the evidence rows. Texts are the merchant's own ad
 * copy, cleaned like every third-party string before the model sees them.
 */

const MAX_ADS = 12;
const MAX_TEXTS_PER_LIST = 6;

function trimTexts(rsa: RsaSummary, label: 'LOW' | 'BEST') {
  const pick = (assets: RsaSummary['headlines']) =>
    assets
      .filter((a) => a.label === label)
      .slice(0, MAX_TEXTS_PER_LIST)
      .map((a) => ({ text: cleanText(a.text), pinned: a.pinned_field !== null }));
  return { headlines: pick(rsa.headlines), descriptions: pick(rsa.descriptions) };
}

async function verifiedPhoneFor(ctx: Parameters<JarvisReadTool['run']>[1]): Promise<PhoneResolution> {
  let merchantSaved: string[] = [];
  try {
    const admin = createAdminClient();
    const { data } = await admin.from('google_ads_accounts').select('business_id').eq('id', ctx.accountId).maybeSingle();
    merchantSaved = await readMerchantSavedPhones(admin, data?.business_id ?? null);
  } catch {
    merchantSaved = [];
  }
  const accountPhones = (await readAccountCallPhones(ctx.customer)) ?? [];
  return resolveVerifiedPhone({ merchantSaved, accountPhones });
}

export const getAdAssetsTool: JarvisReadTool = {
  name: 'get_ad_assets',
  description:
    "Reads the account's responsive search ads asset by asset: Google's performance label per headline and description (BEST, GOOD, LOW, LEARNING, PENDING), ad strength, policy problems, which Search campaigns miss sitelinks, callouts, a structured snippet or a call asset, and the result of any A/B test between two ads in one ad group. Use it before saying anything about ad copy quality. LOW labels only mean something with 1000+ impressions. Read only: it never changes the account.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);

    const [report, coverage, tests, groups] = await Promise.all([
      readRsaAssets(ctx.customer),
      readExtensionCoverage(ctx.customer),
      readAdTests(ctx.customer),
      readAssetGroups(ctx.customer),
    ]);
    if (!report.readable) throw new Error('responsive search ads unreadable');

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const ads: Array<Record<string, unknown>> = [];

    for (const rsa of report.rsas.filter((r) => r.status !== 'REMOVED').slice(0, MAX_ADS)) {
      const verdict = assetVerdict(rsa);
      const ref = nextRef('rsa');
      const compact = {
        campaign: cleanText(rsa.campaign_name),
        ad_group: cleanText(rsa.ad_group_name),
        status: rsa.status,
        ad_strength: rsa.ad_strength || 'UNKNOWN',
        impressions_30d: rsa.impressions_30d,
        conversions_30d: Math.round(rsa.conversions_30d * 10) / 10,
        labels: verdict.counts,
        labels_source: rsa.labels_from_view ? 'asset_view' : 'ad_inline',
        low: trimTexts(rsa, 'LOW'),
        best: trimTexts(rsa, 'BEST'),
        policy_problems: [...rsa.headlines, ...rsa.descriptions]
          .filter((a) => a.approval === 'DISAPPROVED' || a.approval === 'APPROVED_LIMITED')
          .slice(0, 5)
          .map((a) => ({ text: cleanText(a.text), approval: a.approval, topics: a.policy_topics.map(cleanText) })),
        replaceable: verdict.replace.length,
        // Numbered so prepare_change can name a text without typing it (n is the position here, starting at 1).
        replaceable_texts: verdict.replace.map((candidate, index) => ({
          n: index + 1,
          field: candidate.field,
          reason: candidate.reason,
          text: cleanText(candidate.text),
        })),
        not_proposed_because: verdict.skip_reason,
      };
      evidence.push({
        ref,
        kind: 'rsa_ad',
        data: { ...compact, ad_group_ad: rsa.ad_group_ad, campaign_resource: rsa.campaign, verdict },
      });
      ads.push({ ref, ...compact });
    }

    const testItems = (tests ?? []).map((t) => {
      const ref = nextRef('tst');
      const compact = {
        ad_group: cleanText(t.ad_group_name),
        status: t.verdict.status,
        days_compared: t.verdict.days_compared,
        confidence: t.verdict.confidence,
        lift_pct: t.verdict.lift_pct,
        rates: t.verdict.rates.map(({ conversions_per_1000_impressions, cpa }) => ({ conversions_per_1000_impressions, cpa })),
        note_ar: t.verdict.note_ar,
      };
      evidence.push({
        ref,
        kind: 'ad_test',
        data: { ...compact, ad_group: t.ad_group, ads: t.ads, winner: t.verdict.winner, loser: t.verdict.loser },
      });
      return { ref, ...compact };
    });

    // The only phone numbers a call asset may use: one the merchant saved, or one already serving in the account.
    const phone = await verifiedPhoneFor(ctx);
    if (phone.status === 'found') {
      evidence.push({ ref: nextRef('ph'), kind: 'verified_phone', data: { phone: phone.value.phone, source: phone.value.source } });
    }

    return okResult(
      {
        verified_phone: phone.status === 'found' ? { available: true, ref: evidence[evidence.length - 1].ref, source: phone.value.source } : { available: false, reason: phone.status },
        rsa_count: report.rsas.length,
        ads,
        campaigns_missing_assets: (coverage ?? [])
          .filter((c) => c.missing.length > 0)
          .slice(0, 10)
          .map((c) => ({ campaign: cleanText(c.campaign_name), missing: c.missing })),
        extension_coverage_readable: coverage !== null,
        ad_tests: tests === null ? { readable: false } : { readable: true, tests: testItems },
        pmax_asset_groups:
          groups === null
            ? { readable: false }
            : {
                readable: true,
                note: 'Per-asset performance labels are not available for Performance Max asset groups in API v22; only ad strength, status and policy.',
                groups: groups.slice(0, 10).map((g) => ({
                  name: cleanText(g.name),
                  ad_strength: g.ad_strength,
                  primary_status: g.primary_status,
                  disapproved_assets: g.disapproved_assets,
                  limited_assets: g.limited_assets,
                })),
              },
      },
      evidence
    );
  },
};
