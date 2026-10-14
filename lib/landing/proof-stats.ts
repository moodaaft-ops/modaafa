import { unstable_cache } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Live proof for the public pages, read from the database and never typed by
 * hand: how many distinct Google Ads accounts were audited, how many decisions
 * the platform prepared for their owners, and the estimated monthly value of
 * those decisions in SAR (the «delta_sar_per_month» each decision carries,
 * positive values only). Cached for an hour.
 *
 * Any failure returns null and the line that uses it stays hidden.
 */
const ROW_CAP = 20000;

type ProofCounts = {
  auditedAccounts: number | null;
  recommendations: number | null;
  monthlyImpactSar: number | null;
};

async function readCounts(): Promise<ProofCounts> {
  const out: ProofCounts = { auditedAccounts: null, recommendations: null, monthlyImpactSar: null };
  try {
    const admin = createAdminClient();
    const [audits, recs] = await Promise.all([
      admin.from('audits').select('account_id').limit(ROW_CAP),
      admin.from('recommendations').select('expected_impact').limit(ROW_CAP),
    ]);
    // A truncated read would understate, so hitting the cap counts as unknown.
    if (!audits.error && Array.isArray(audits.data) && audits.data.length < ROW_CAP) {
      out.auditedAccounts = new Set(audits.data.map((row: { account_id: string }) => row.account_id)).size;
    }
    if (!recs.error && Array.isArray(recs.data) && recs.data.length < ROW_CAP) {
      out.recommendations = recs.data.length;
      let total = 0;
      for (const row of recs.data as Array<{ expected_impact: unknown }>) {
        const impact = row.expected_impact as { delta_sar_per_month?: unknown } | null;
        const value = Number(impact?.delta_sar_per_month);
        if (Number.isFinite(value) && value > 0) total += value;
      }
      out.monthlyImpactSar = Math.round(total);
    }
  } catch {
    // keep nulls
  }
  return out;
}

const cachedCounts = unstable_cache(readCounts, ['landing-proof-counts-v3'], { revalidate: 3600 });

/** Each count comes back only when it reaches its minimum; otherwise null. */
export async function getProofCounts(min: {
  auditedAccounts: number | null;
  recommendations: number | null;
  monthlyImpactSar: number | null;
}): Promise<ProofCounts> {
  const counts = await cachedCounts().catch(
    (): ProofCounts => ({ auditedAccounts: null, recommendations: null, monthlyImpactSar: null })
  );
  const gate = (value: number | null, minimum: number | null) =>
    minimum === null || value === null || value < minimum ? null : value;
  return {
    auditedAccounts: gate(counts.auditedAccounts, min.auditedAccounts),
    recommendations: gate(counts.recommendations, min.recommendations),
    monthlyImpactSar: gate(counts.monthlyImpactSar, min.monthlyImpactSar),
  };
}
