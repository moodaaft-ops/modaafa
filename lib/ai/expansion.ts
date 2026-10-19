import { applyBuilderGates, PMAX_MIN_CONVERSIONS_30D, type BuilderAccountSignals } from './builder-gates';
import { readCampaignEntries, SCALE_MIN_CONVERSIONS_30D, TRACKING_HEALTHY } from './optimizer-gates';
import type { OptimizerSnapshot } from './optimizer-agent';
import { allowableCpaScale, hasBreakEven } from '../economics/break-even';
import type { ConvertingTermRow } from './opportunity';

/**
 * Horizontal expansion ideas (EXPANSION_IDEAS_ENABLED, default off). RECOMMENDATIONS ONLY.
 *
 * When a Search campaign has already taken most of the demand it can reach (high
 * impression share, little lost to rank, little lost to budget) AND it earns
 * under the owner's break-even, squeezing it further does little; the next
 * money comes from somewhere else. The idea is a brief for the assistant (the
 * same path as the winning-terms card), whose draft the merchant builds PAUSED
 * through «ابنِ الحملة موقوفة». Nothing here changes the Google Ads account.
 *
 * Rules, no model, and every number in the text is a measured one.
 */

export const EXPANSION_OPERATION = 'expansion_idea';

/** primary_goal text -> objective. Unknown stays null (no campaign-type idea). */
export function objectiveFromGoal(goal: string | null | undefined): 'SALES' | 'LEADS' | null {
  const g = String(goal ?? '').toLowerCase();
  if (!g) return null;
  if (/lead|call|book|inquir|عميل|حجز|اتصال|استفسار|مكالم/.test(g)) return 'LEADS';
  if (/sale|order|purchase|ecom|مبيع|طلب|شراء|متجر/.test(g)) return 'SALES';
  return null;
}

export function expansionIdeasEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXPANSION_IDEAS_ENABLED === 'true';
}

/** "Saturated" thresholds. Search impression share is read per campaign (keyword level is not read). */
export const EXPANSION_THRESHOLDS = {
  maxLostRankIs: 0.15,
  maxLostBudgetIs: 0.1,
  minSearchIs: 0.45,
  minConversions30d: SCALE_MIN_CONVERSIONS_30D,
} as const;

export type SaturatedCampaign = {
  resource: string;
  name: string;
  search_is: number;
  lost_rank_is: number;
  lost_budget_is: number;
  conversions: number;
  cost: number;
  cpa: number | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type Econ = OptimizerSnapshot['economics'];

/** Under the owner's scale yardstick: CPA under the limit, or ROAS over the break-even ROAS. Unknown economics: false. */
export function isProfitable(economics: Econ, cost: number, conversions: number, value: number): boolean {
  if (!economics || cost <= 0 || conversions <= 0) return false;
  const cpaLimit = allowableCpaScale(economics)?.value ?? null;
  if (cpaLimit !== null) return cost / conversions <= cpaLimit;
  const roasLimit = economics.break_even_roas ?? null;
  return roasLimit !== null && value > 0 && value / cost >= roasLimit;
}

/** Campaigns that are saturated AND profitable on the owner's break-even. Empty when tracking or economics are not trusted. */
export function findSaturatedCampaigns(snapshot: Pick<OptimizerSnapshot, 'campaigns' | 'conversion_tracking' | 'economics'>): SaturatedCampaign[] {
  if (snapshot.conversion_tracking?.status !== TRACKING_HEALTHY) return [];
  const economics = snapshot.economics ?? null;
  if (!economics) return [];
  if (!hasBreakEven(economics)) return [];

  const out: SaturatedCampaign[] = [];
  for (const entry of readCampaignEntries(snapshot)) {
    const diag = entry.diag;
    const last = entry.last30d;
    if (!diag || !last) continue;
    if (String(diag.type ?? '').toUpperCase() !== 'SEARCH') continue;
    if (String(diag.primary_status ?? '').toUpperCase() === 'LEARNING') continue;
    const searchIs = num(diag.search_is);
    const lostRank = num(diag.lost_rank_is);
    const lostBudget = num(diag.lost_budget_is);
    if (searchIs === null || lostRank === null || lostBudget === null) continue;
    if (searchIs < EXPANSION_THRESHOLDS.minSearchIs) continue;
    if (lostRank > EXPANSION_THRESHOLDS.maxLostRankIs) continue;
    if (lostBudget > EXPANSION_THRESHOLDS.maxLostBudgetIs) continue;
    if (last.conversions < EXPANSION_THRESHOLDS.minConversions30d) continue;
    const cost = last.cost_micros / 1_000_000;
    const cpa = last.conversions > 0 ? cost / last.conversions : null;
    if (!isProfitable(economics, cost, last.conversions, last.conversions_value)) continue;
    out.push({ resource: entry.resource, name: entry.name, search_is: searchIs, lost_rank_is: lostRank, lost_budget_is: lostBudget, conversions: last.conversions, cost, cpa });
  }
  return out.sort((a, b) => b.conversions - a.conversions);
}

// ---------------------------------------------------------------------------
// New geo (from the geo report)
// ---------------------------------------------------------------------------

export type GeoRow = { resource: string; name: string | null; cost: number; clicks: number; conversions: number; value?: number };

export const GEO_MIN_CONVERSIONS = 2;

/** Cities that already bring conversions under the limit and that no campaign targets (nor a parent area of them). */
export function suggestNewGeos(args: {
  rows: readonly GeoRow[];
  /** geoTargetConstants/... that any enabled campaign targets (positive). */
  targeted: ReadonlySet<string>;
  /** City resource -> its parent chain (province, country), when known. A city under a targeted area is covered. */
  parents: ReadonlyMap<string, readonly string[]>;
  economics: Econ;
}): GeoRow[] {
  return args.rows
    .filter((row) => row.name && row.conversions >= GEO_MIN_CONVERSIONS && row.cost > 0)
    .filter((row) => isProfitable(args.economics, row.cost, row.conversions, row.value ?? 0))
    .filter((row) => {
      if (args.targeted.has(row.resource)) return false;
      const chain = args.parents.get(row.resource);
      // Unknown ancestry could hide a covering province: do not suggest.
      if (!chain) return false;
      return !chain.some((p) => args.targeted.has(p));
    })
    .sort((a, b) => b.conversions - a.conversions)
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// New ad group from converting search-term clusters
// ---------------------------------------------------------------------------

export type TermCluster = { theme: string; terms: ConvertingTermRow[]; conversions: number; cost: number; value: number };

const STOP = new Set(['في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'قريب', 'near', 'the', 'for', 'and']);
const strip = (s: string) => s.replace(/[ً-ٰٟ]/g, '').toLowerCase().trim();

export function clusterConvertingTerms(terms: readonly ConvertingTermRow[], minTerms = 2, minConversions = 3): TermCluster[] {
  const qualified = terms.filter((t) => t.conversions >= 1 && t.term);
  const tokensOf = (t: ConvertingTermRow) => [...new Set(strip(t.term).split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const weight = new Map<string, { terms: Set<ConvertingTermRow>; conversions: number }>();
  for (const t of qualified) {
    for (const token of tokensOf(t)) {
      const e = weight.get(token) ?? { terms: new Set(), conversions: 0 };
      e.terms.add(t);
      e.conversions += t.conversions;
      weight.set(token, e);
    }
  }
  const used = new Set<ConvertingTermRow>();
  const clusters: TermCluster[] = [];
  const ranked = [...weight.entries()].filter(([, e]) => e.terms.size >= minTerms).sort((a, b) => b[1].conversions - a[1].conversions);
  for (const [theme, e] of ranked) {
    const members = [...e.terms].filter((t) => !used.has(t));
    if (members.length < minTerms) continue;
    const conversions = members.reduce((s, t) => s + t.conversions, 0);
    if (conversions < minConversions) continue;
    members.forEach((t) => used.add(t));
    clusters.push({ theme, terms: members.sort((a, b) => b.conversions - a.conversions).slice(0, 8), conversions, cost: members.reduce((s, t) => s + t.cost, 0), value: members.reduce((s, t) => s + (t.conversion_value || 0), 0) });
  }
  return clusters.slice(0, 3);
}

// ---------------------------------------------------------------------------
// New campaign type (Shopping or PMax) through the builder gates
// ---------------------------------------------------------------------------

export function suggestCampaignType(args: {
  signals: BuilderAccountSignals;
  objective: 'SALES' | 'LEADS' | null;
  existingTypes: ReadonlySet<string>;
}): 'SHOPPING' | 'PMAX' | null {
  // Shopping and PMax are for selling products. Leads or an unknown goal: no suggestion.
  if (args.objective !== 'SALES') return null;
  // Ask the same gates the builder applies: a type the gates would downgrade is not suggested.
  for (const candidate of ['PMAX', 'SHOPPING'] as const) {
    if (args.existingTypes.has(candidate)) continue;
    const probe = applyBuilderGates({ type: candidate, objective: 'SALES' }, { brief: '', signals: args.signals });
    if (probe.draft.type === candidate) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

export type ExpansionIdea =
  | { kind: 'new_geo'; key: string; geos: GeoRow[]; from: SaturatedCampaign }
  | { kind: 'new_ad_group'; key: string; cluster: TermCluster; from: SaturatedCampaign }
  | { kind: 'new_campaign_type'; key: string; campaign_type: 'SHOPPING' | 'PMAX'; from: SaturatedCampaign };

export function detectExpansionIdeas(input: {
  snapshot: Pick<OptimizerSnapshot, 'campaigns' | 'conversion_tracking' | 'economics'>;
  geo: { rows: readonly GeoRow[]; targeted: ReadonlySet<string>; parents: ReadonlyMap<string, readonly string[]> } | null;
  terms: readonly ConvertingTermRow[];
  signals: BuilderAccountSignals | null;
  objective: 'SALES' | 'LEADS' | null;
}): ExpansionIdea[] {
  const saturated = findSaturatedCampaigns(input.snapshot);
  if (saturated.length === 0) return [];
  const from = saturated[0];
  const economics = input.snapshot.economics ?? null;
  const ideas: ExpansionIdea[] = [];

  if (input.geo) {
    const geos = suggestNewGeos({ ...input.geo, economics });
    if (geos.length > 0) ideas.push({ kind: 'new_geo', key: geos.map((g) => g.resource).sort().join(','), geos, from });
  }
  const cluster = clusterConvertingTerms(input.terms).find((c) => isProfitable(economics, c.cost, c.conversions, c.value));
  if (cluster) ideas.push({ kind: 'new_ad_group', key: cluster.theme, cluster, from });

  if (input.signals) {
    const existing = new Set(
      readCampaignEntries(input.snapshot).map((e) => String(e.diag?.type ?? '').toUpperCase().replace('PERFORMANCE_MAX', 'PMAX'))
    );
    const type = suggestCampaignType({ signals: input.signals, objective: input.objective, existingTypes: existing });
    if (type) ideas.push({ kind: 'new_campaign_type', key: type, campaign_type: type, from });
  }
  return ideas;
}

// ---------------------------------------------------------------------------
// The recommendation row
// ---------------------------------------------------------------------------

const r1 = (n: number) => Number(n.toFixed(1));
const r2 = (n: number) => Number(n.toFixed(2));
const pct = (n: number) => Math.round(n * 100);

function saturationLine(from: SaturatedCampaign, currency: string): string {
  return (
    `حملة "${from.name}" ماسكة ${pct(from.search_is)}% من الظهور الممكن، وخسارتها بسبب الترتيب ${pct(from.lost_rank_is)}% وبسبب الميزانية ${pct(from.lost_budget_is)}%، ` +
    `وتكلفة التحويل فيها ${from.cpa === null ? 'غير محسوبة' : `${r2(from.cpa)} ${currency}`} تحت حدك. يعني كبّرنا اللي عندها تقريباً للآخر، والنمو الجاي من مكان ثاني.`
  );
}

export function buildExpansionRecommendation(idea: ExpansionIdea, currency = 'SAR') {
  const base = saturationLine(idea.from, currency);
  let title: string;
  let brief: string;
  let impact: Record<string, unknown>;
  let detail: Record<string, unknown>;

  if (idea.kind === 'new_geo') {
    const list = idea.geos.map((g) => `${g.name} (${r1(g.conversions)} تحويل بتكلفة ${r2(g.cost)} ${currency})`).join('، ');
    title = `فرصة توسع: تجيك تحويلات من ${idea.geos.map((g) => g.name).join(' و')} وهي خارج استهدافك`;
    brief =
      `جهّز لي مسودة حملة بحث موقوفة لمدينة أو أكثر من هالمدن اللي تجيني منها تحويلات وما هي في استهدافي الحالي: ${list}. ` +
      `خذ كلمات وإعلانات حملة "${idea.from.name}" كأساس، وخلها حملة منفصلة بميزانية صغيرة تحت المراقبة. بدون أي توقع لأرقام النقرات أو التحويلات.`;
    impact = { metric: 'conversions', basis: 'measured_30d', conversions: r1(idea.geos.reduce((s, g) => s + g.conversions, 0)), cost: r2(idea.geos.reduce((s, g) => s + g.cost, 0)), currency };
    detail = { geos: idea.geos.map((g) => ({ resource: g.resource, name: g.name, conversions: g.conversions, cost: r2(g.cost) })) };
  } else if (idea.kind === 'new_ad_group') {
    const c = idea.cluster;
    const list = c.terms.map((t) => `«${t.term}» (${r1(t.conversions)} تحويل)`).join('، ');
    title = `فرصة توسع: مجموعة إعلانية جديدة لموضوع "${c.theme}" عبارات بحثه تحوّل`;
    brief =
      `جهّز لي مسودة مجموعة إعلانية جديدة لموضوع "${c.theme}" من عبارات البحث اللي حوّلت عندي: ${list}. ` +
      `قل لي أول شي إذا عندي مجموعة بنفس الموضوع أصلاً وخل الكلمات فيها. إذا ما عندي، اقترح الكلمات بالمطابقة الصح وإعلانات من كلامي. بدون توقع أرقام.`;
    impact = { metric: 'conversions', basis: 'measured_30d', conversions: r1(c.conversions), cost: r2(c.cost), currency };
    detail = { theme: c.theme, terms: c.terms.map((t) => ({ term: t.term, conversions: t.conversions, cost: r2(t.cost) })) };
  } else {
    const label = idea.campaign_type === 'PMAX' ? 'أداء أقصى' : 'تسوق';
    title = `فرصة توسع: حملة ${label} لمتجرك بجانب البحث`;
    brief =
      `جهّز لي مسودة حملة ${label} موقوفة لمتجري، مرتبطة بـ Merchant Center الموجود في حسابي. ` +
      `التزم بشروط المنصة للنوع هذا، وقل لي أي شرط ناقص قبل ما تبني. بدون توقع أرقام.`;
    impact = { metric: 'conversions', basis: 'measured_30d', conversions: r1(idea.from.conversions), cost: r2(idea.from.cost), currency };
    detail = { campaign_type: idea.campaign_type, gate: idea.campaign_type === 'PMAX' ? `merchant_center_and_${PMAX_MIN_CONVERSIONS_30D}_conversions` : 'merchant_center' };
  }

  const description = `${base} ${brief.split('. ')[0]}. افتح المساعد وبيجهّز لك مسودة للمراجعة، وتبنيها موقوفة بنفسك لما تعجبك.`;
  return {
    category: 'structure' as const,
    severity: 'growth' as const,
    title: title.slice(0, 120),
    description,
    expected_impact: impact,
    action_payload: {
      operation: EXPANSION_OPERATION,
      kind: idea.kind,
      brief_ar: brief,
      saturated_campaign: { name: idea.from.name, search_is: r2(idea.from.search_is), lost_rank_is: r2(idea.from.lost_rank_is), lost_budget_is: r2(idea.from.lost_budget_is) },
      ...detail,
      source: 'optimizer_cron' as const,
    },
  };
}
