import type { CoachingInput, LeadStats } from './response-coaching';

type Query = { query(gaql: string): Promise<any[]> };

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function metricsSum(rows: any[]) {
  return rows.reduce(
    (sum, row) => {
      const m = row?.metrics ?? {};
      sum.clicks += num(m.clicks);
      sum.impressions += num(m.impressions);
      sum.conversions += num(m.conversions);
      return sum;
    },
    { clicks: 0, impressions: 0, conversions: 0 }
  );
}

function isoDay(date: Date, offsetDays: number) {
  return new Date(date.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Reads the two windows and the merchant's lead verdicts. The lead table comes
 * from the lead-quality loop; when it does not exist (or the loop is off) the
 * lead detectors simply have no input and stay quiet.
 */
export async function loadCoachingInput(args: {
  customer: Query;
  admin: any | null;
  accountId: string;
  now: Date;
  sectorMedianCtr?: number | null;
}): Promise<CoachingInput> {
  const { customer, admin, accountId, now } = args;
  const earlyFrom = isoDay(now, -120);
  const earlyTo = isoDay(now, -31);

  const [current, earlier] = await Promise.all([
    customer.query(`SELECT metrics.clicks, metrics.impressions, metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS`),
    customer
      .query(
        `SELECT metrics.clicks, metrics.impressions, metrics.conversions FROM customer WHERE segments.date BETWEEN '${earlyFrom}' AND '${earlyTo}'`
      )
      .catch(() => null as any[] | null),
  ]);

  const now30 = metricsSum(current);
  return {
    windowDays: 30,
    ...now30,
    history: earlier ? metricsSum(earlier) : null,
    leads: admin ? await loadLeadStats(admin, accountId, now) : null,
    sectorMedianCtr: args.sectorMedianCtr ?? null,
  };
}

export async function loadLeadStats(admin: any, accountId: string, now: Date): Promise<LeadStats | null> {
  try {
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const { data, error } = await admin
      .from('lead_clicks')
      .select('status')
      .eq('account_id', accountId)
      .gte('clicked_at', since)
      .limit(5000);
    if (error || !Array.isArray(data)) return null;
    const stats: LeadStats = { total: data.length, marked: 0, customers: 0, notSerious: 0, noReply: 0 };
    for (const row of data) {
      if (row.status && row.status !== 'new') stats.marked += 1;
      if (row.status === 'customer') stats.customers += 1;
      if (row.status === 'not_serious') stats.notSerious += 1;
      if (row.status === 'no_reply') stats.noReply += 1;
    }
    return stats;
  } catch {
    return null;
  }
}
