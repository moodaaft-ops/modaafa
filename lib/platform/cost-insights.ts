/**
 * Turns the llm_usage ledger and the optimizer's job_runs into the readings on
 * /operations/costs. Pure functions only: the page loads rows, this file does
 * the arithmetic, and the tests pin the arithmetic.
 *
 * Days are Riyadh calendar days (UTC+3, no daylight saving), because that is
 * the day the operator thinks in.
 */

import { priceFor } from '../ai/pricing';
import type { AnthropicCreditReading } from './cost-config';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const RIYADH_OFFSET_MS = 3 * HOUR_MS;

export type UsageRow = {
  created_at: string;
  user_id: string | null;
  feature: string | null;
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
  priced: boolean | null;
};

export type OptimizeRunRow = {
  started_at: string;
  status: string | null;
  details: Record<string, unknown> | null;
};

export type CostAlertCode =
  | 'daily_spike'
  | 'week_rise'
  | 'unpriced_calls'
  | 'metering_gap'
  | 'runway_critical'
  | 'runway_low'
  | 'promo_expiring'
  | 'promo_expired'
  | 'reading_stale'
  | 'auto_reload_off';

export type CostAlert = {
  code: CostAlertCode;
  tone: 'danger' | 'warning' | 'info';
  values: Record<string, number | string>;
};

export type SpendWindow = { costUsd: number; calls: number };

export type DailySpend = { day: string; costUsd: number; calls: number; optimizerUsd: number };

export type SpendShare = { key: string; costUsd: number; calls: number; share: number };

export type TopUser = { userId: string | null; costUsd: number; calls: number; topFeature: string | null };

export type CreditReport = {
  balanceAtReadUsd: number;
  readAt: string;
  readAgeDays: number;
  spentSinceReadUsd: number;
  estimatedBalanceUsd: number;
  purchasedUsd: number;
  promoUsd: number;
  promoExpiresOn: string | null;
  daysToPromoExpiry: number | null;
  /** The promotional part has already expired and was taken off the estimate. */
  promoExpired: boolean;
  dailyAvgUsd: number;
  /** Days until the money runs out, counting the promotional part only until it expires. */
  runwayDays: number | null;
  /** Paid credit still expected on the day the promotional part expires. */
  paidAtExpiryUsd: number | null;
  paidRunwayDays: number | null;
  autoReload: boolean;
};

export type CostReport = {
  generatedAt: number;
  today: string;
  /** First Riyadh day that has any ledger row, or null for an empty ledger. */
  firstRowDay: string | null;
  /** How many of the last 7 days the ledger actually covers (1 to 7). */
  observedDays7: number;
  /**
   * How many finished days stand behind the daily average. Zero means the ledger
   * has no finished day yet and the average falls back to today's partial figure.
   */
  avgDailyDays: number;
  todaySpend: SpendWindow;
  yesterday: SpendWindow;
  last7: SpendWindow & { avgDailyUsd: number };
  /** Null until the ledger covers 14 days, so the comparison is never half empty. */
  prev7: (SpendWindow & { avgDailyUsd: number }) | null;
  last30: SpendWindow;
  monthToDate: SpendWindow & { dayOfMonth: number; daysInMonth: number };
  /** Month to date plus the 7 day daily average for the days still to come. */
  monthProjectionUsd: number;
  next30DaysUsd: number;
  daily: DailySpend[];
  byFeature: SpendShare[];
  byModel: SpendShare[];
  cache: {
    readTokens: number;
    writeTokens: number;
    freshInputTokens: number;
    /** cache reads / all input tokens (fresh + read + write), last 7 days. */
    hitRatio: number | null;
    /** What caching saved minus what its write premium cost, last 7 days. */
    netSavingUsd: number;
  };
  optimizer: {
    runs7: number;
    runs30: number;
    failedRuns7: number;
    ledgerCalls7: number;
    costUsd7: number;
    costPerCall7: number | null;
    costPerRun7: number | null;
    /** Runs since the cost guards shipped (their details carry model_calls). */
    guardRuns7: number;
    skippedIdle7: number;
    cooledDown7: number;
    /** Guard counts priced at the average cost of one optimizer call. An estimate. */
    avoidedUsd7: number | null;
  };
  topUsers: TopUser[];
  unpricedCalls30: number;
  credit: CreditReport | null;
  alerts: CostAlert[];
};

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (value: number) => Math.round(value * 100) / 100;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** YYYY-MM-DD of the Riyadh calendar day that contains the instant. */
export function riyadhDayKey(ms: number): string {
  return new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

function daysInRiyadhMonth(ms: number) {
  const shifted = new Date(ms + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
}

function dayOfRiyadhMonth(ms: number) {
  return new Date(ms + RIYADH_OFFSET_MS).getUTCDate();
}

function dayDiff(fromDay: string, toDay: string) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

function rowMs(row: { created_at: string }) {
  const ms = Date.parse(row.created_at);
  return Number.isFinite(ms) ? ms : null;
}

function topKeys(map: Map<string, { costUsd: number; calls: number }>, total: number): SpendShare[] {
  return Array.from(map.entries())
    .map(([key, value]) => ({
      key,
      costUsd: round6(value.costUsd),
      calls: value.calls,
      share: total > 0 ? value.costUsd / total : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

/**
 * Net effect of the prompt cache on one request: tokens read from the cache
 * would have cost the full input price, and tokens written cost a premium over
 * it. Positive means the cache paid for itself.
 */
export function cacheNetSavingUsd(
  model: string | null,
  usage: { input: number; cacheRead: number; cacheWrite: number }
) {
  const price = priceFor(model, usage.input + usage.cacheRead + usage.cacheWrite);
  const saved = usage.cacheRead * (price.input - price.cacheRead);
  const premium = usage.cacheWrite * (price.cacheWrite - price.input);
  return (saved - premium) / 1e6;
}

/**
 * Highest monthly optimizer spend the cooldown allows: every active account
 * optimized as often as the cooldown permits, all month. Null when the cooldown
 * is off (no ceiling) or the cost of one call is not known yet.
 */
export function optimizerMonthlyCeilingUsd(
  activeAccounts: number,
  cooldownHours: number,
  costPerCallUsd: number | null
) {
  if (!Number.isFinite(cooldownHours) || cooldownHours <= 0) return null;
  if (costPerCallUsd === null || !Number.isFinite(costPerCallUsd)) return null;
  const passesPerDay = Math.min(24, 24 / cooldownHours);
  return round2(Math.max(0, activeAccounts) * passesPerDay * costPerCallUsd * 30);
}

function emptyWindow(): SpendWindow {
  return { costUsd: 0, calls: 0 };
}

export function buildCreditReport(
  credit: AnthropicCreditReading,
  ledgerRows: UsageRow[],
  dailyAvgUsd: number,
  now: number
): CreditReport {
  const readAtMs = Date.parse(credit.readAt);
  let spentSince = 0;
  if (Number.isFinite(readAtMs)) {
    for (const row of ledgerRows) {
      const ms = rowMs(row);
      if (ms !== null && ms >= readAtMs) spentSince += num(row.cost_usd);
    }
  }
  spentSince = round2(spentSince);
  let estimated = Math.max(0, round2(credit.balanceUsd - spentSince));
  const promoUsd = Math.max(0, round2(credit.balanceUsd - credit.purchasedUsd));

  const todayKey = riyadhDayKey(now);
  let daysToPromoExpiry: number | null = null;
  let promoExpired = false;
  if (credit.promoExpiresOn) {
    const diff = dayDiff(todayKey, credit.promoExpiresOn);
    daysToPromoExpiry = diff >= 0 ? diff : null;
    // The promotional part is gone once its day has passed, unless the reading
    // was itself taken after that day (then the console balance already excludes it).
    const readAfterExpiry = Number.isFinite(readAtMs) && riyadhDayKey(readAtMs) > credit.promoExpiresOn;
    promoExpired = diff < 0 && !readAfterExpiry;
  }
  // After expiry, assume the promotional part was spent first (that is the part
  // that disappears), so only the purchased part can remain.
  if (promoExpired) estimated = Math.min(estimated, Math.max(0, round2(credit.purchasedUsd)));

  let paidAtExpiryUsd: number | null = null;
  let paidRunwayDays: number | null = null;
  let runwayDays: number | null = dailyAvgUsd > 0 ? Math.floor(estimated / dailyAvgUsd) : null;
  if (daysToPromoExpiry !== null) {
    // Assumes the promotional part is spent before the purchased part, so the
    // paid credit survives the expiry unless the whole balance runs out first.
    const balanceAtExpiry = Math.max(0, estimated - dailyAvgUsd * daysToPromoExpiry);
    paidAtExpiryUsd = round2(Math.min(credit.purchasedUsd, balanceAtExpiry));
    paidRunwayDays = dailyAvgUsd > 0 ? Math.floor(paidAtExpiryUsd / dailyAvgUsd) : null;
    // The balance includes promotional money that vanishes on the expiry day,
    // so the real runway is the days until then plus what the paid part covers.
    if (dailyAvgUsd > 0 && runwayDays !== null) {
      runwayDays = Math.min(runwayDays, daysToPromoExpiry + (paidRunwayDays ?? 0));
    }
  }

  return {
    balanceAtReadUsd: credit.balanceUsd,
    readAt: credit.readAt,
    readAgeDays: Number.isFinite(readAtMs) ? Math.max(0, Math.floor((now - readAtMs) / DAY_MS)) : 0,
    spentSinceReadUsd: spentSince,
    estimatedBalanceUsd: estimated,
    purchasedUsd: credit.purchasedUsd,
    promoUsd,
    promoExpiresOn: credit.promoExpiresOn,
    daysToPromoExpiry,
    promoExpired,
    dailyAvgUsd: round2(dailyAvgUsd),
    runwayDays,
    paidAtExpiryUsd,
    paidRunwayDays,
    autoReload: credit.autoReload,
  };
}

export type CostReportOptions = {
  now: number;
  /** A day above this many dollars raises an alert. */
  dailyAlertUsd: number;
  credit?: AnthropicCreditReading | null;
  staleCreditDays?: number;
  runwayWarningDays?: number;
  runwayDangerDays?: number;
};

export function buildCostReport(
  rows: UsageRow[],
  runs: OptimizeRunRow[],
  options: CostReportOptions
): CostReport {
  const { now } = options;
  const today = riyadhDayKey(now);
  const days30: string[] = [];
  for (let i = 29; i >= 0; i -= 1) days30.push(riyadhDayKey(now - i * DAY_MS));
  const last7Days = new Set(days30.slice(-7));
  const prev7Days = new Set(days30.slice(-14, -7));
  const yesterdayKey = days30[days30.length - 2];
  const monthPrefix = today.slice(0, 7);

  const byDay = new Map<string, DailySpend>(days30.map((day) => [day, { day, costUsd: 0, calls: 0, optimizerUsd: 0 }]));
  const features = new Map<string, { costUsd: number; calls: number }>();
  const models = new Map<string, { costUsd: number; calls: number }>();
  const users = new Map<string, { userId: string | null; costUsd: number; calls: number; features: Map<string, number> }>();

  const last7 = emptyWindow();
  const prev7 = emptyWindow();
  const last30 = emptyWindow();
  const monthToDate = emptyWindow();
  const optimizer = { costUsd7: 0, calls7: 0 };
  const cache = { read: 0, write: 0, fresh: 0, netSaving: 0 };
  let unpriced30 = 0;
  let firstRowDay: string | null = null;

  for (const row of rows) {
    const ms = rowMs(row);
    if (ms === null) continue;
    const day = riyadhDayKey(ms);
    if (firstRowDay === null || day < firstRowDay) firstRowDay = day;

    const cost = num(row.cost_usd);
    const feature = (row.feature ?? '').trim() || 'unknown';
    const model = (row.model ?? '').trim() || 'unknown';

    if (day.startsWith(monthPrefix) && day <= today) {
      monthToDate.costUsd += cost;
      monthToDate.calls += 1;
    }

    const bucket = byDay.get(day);
    if (!bucket) continue; // older than the 30 day window
    bucket.costUsd += cost;
    bucket.calls += 1;
    if (feature === 'optimizer') bucket.optimizerUsd += cost;

    last30.costUsd += cost;
    last30.calls += 1;
    if (row.priced === false) unpriced30 += 1;

    const featureGroup = features.get(feature) ?? { costUsd: 0, calls: 0 };
    featureGroup.costUsd += cost;
    featureGroup.calls += 1;
    features.set(feature, featureGroup);

    const modelGroup = models.get(model) ?? { costUsd: 0, calls: 0 };
    modelGroup.costUsd += cost;
    modelGroup.calls += 1;
    models.set(model, modelGroup);

    const userKey = row.user_id ?? '';
    const userGroup = users.get(userKey) ?? { userId: row.user_id ?? null, costUsd: 0, calls: 0, features: new Map() };
    userGroup.costUsd += cost;
    userGroup.calls += 1;
    userGroup.features.set(feature, (userGroup.features.get(feature) ?? 0) + cost);
    users.set(userKey, userGroup);

    if (last7Days.has(day)) {
      last7.costUsd += cost;
      last7.calls += 1;
      if (feature === 'optimizer') {
        optimizer.costUsd7 += cost;
        optimizer.calls7 += 1;
      }
      const input = num(row.input_tokens);
      const cacheRead = num(row.cache_read_tokens);
      const cacheWrite = num(row.cache_write_tokens);
      cache.fresh += input;
      cache.read += cacheRead;
      cache.write += cacheWrite;
      cache.netSaving += cacheNetSavingUsd(model, { input, cacheRead, cacheWrite });
    } else if (prev7Days.has(day)) {
      prev7.costUsd += cost;
      prev7.calls += 1;
    }
  }

  // The ledger may be younger than the window, so the daily average divides by
  // the days it actually covers rather than by 7.
  const sinceFirst = firstRowDay === null ? 0 : dayDiff(firstRowDay, today) + 1;
  const observedDays7 = Math.max(1, Math.min(7, sinceFirst));
  // Averages and projections use whole days only: today is still in progress, so
  // counting it with a full day's divisor would make every morning look cheap.
  // With no finished day in the ledger yet, fall back to the partial figure.
  const completeDays7 = days30.slice(-8, -1);
  const completeObserved = firstRowDay === null ? 0 : Math.max(0, Math.min(7, dayDiff(firstRowDay, today)));
  let completeCost7 = 0;
  for (const day of completeDays7) completeCost7 += byDay.get(day)?.costUsd ?? 0;
  const avgDaily7 = completeObserved > 0 ? completeCost7 / completeObserved : last7.costUsd / observedDays7;
  const prev7Complete = firstRowDay !== null && dayDiff(firstRowDay, today) >= 13;

  const dayOfMonth = dayOfRiyadhMonth(now);
  const daysInMonth = daysInRiyadhMonth(now);
  const monthProjection = monthToDate.costUsd + avgDaily7 * Math.max(0, daysInMonth - dayOfMonth);

  const total30 = last30.costUsd;
  const byFeature = topKeys(features, total30);
  const byModel = topKeys(models, total30);

  const topUsers: TopUser[] = Array.from(users.values())
    .map((group) => {
      let topFeature: string | null = null;
      let best = -1;
      for (const [feature, cost] of group.features) {
        if (cost > best) {
          best = cost;
          topFeature = feature;
        }
      }
      return { userId: group.userId, costUsd: round6(group.costUsd), calls: group.calls, topFeature };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
    .slice(0, 8);

  const totalInput = cache.fresh + cache.read + cache.write;

  // ---- Optimizer runs (job_runs) ----
  let runs7 = 0;
  let runs30 = 0;
  let failedRuns7 = 0;
  let guardRuns7 = 0;
  let skippedIdle7 = 0;
  let cooledDown7 = 0;
  for (const run of runs) {
    const ms = Date.parse(run.started_at);
    if (!Number.isFinite(ms)) continue;
    const day = riyadhDayKey(ms);
    if (!byDay.has(day)) continue;
    runs30 += 1;
    if (!last7Days.has(day)) continue;
    runs7 += 1;
    if (run.status === 'failed') failedRuns7 += 1;
    const details = run.details ?? {};
    if (typeof details.model_calls === 'number') {
      guardRuns7 += 1;
      skippedIdle7 += num(details.skipped_idle);
      cooledDown7 += num(details.cooled_down_accounts);
    }
  }
  const costPerCall7 = optimizer.calls7 > 0 ? optimizer.costUsd7 / optimizer.calls7 : null;
  const costPerRun7 = runs7 > 0 && optimizer.costUsd7 > 0 ? optimizer.costUsd7 / runs7 : null;
  const avoidedUsd7 = costPerCall7 === null ? null : round2((skippedIdle7 + cooledDown7) * costPerCall7);

  // ---- Credit ----
  const credit = options.credit ? buildCreditReport(options.credit, rows, avgDaily7, now) : null;

  // ---- Alerts ----
  const alerts: CostAlert[] = [];
  const todaySpend = byDay.get(today) ?? { costUsd: 0, calls: 0 };
  const yesterdaySpend = byDay.get(yesterdayKey) ?? { costUsd: 0, calls: 0 };

  const spikeDay = [todaySpend, yesterdaySpend]
    .map((bucket, index) => ({ bucket, label: index === 0 ? 'today' : 'yesterday' }))
    .find(({ bucket }) => bucket.costUsd >= options.dailyAlertUsd);
  if (spikeDay) {
    alerts.push({
      code: 'daily_spike',
      tone: spikeDay.bucket.costUsd >= options.dailyAlertUsd * 2 ? 'danger' : 'warning',
      values: { when: spikeDay.label, costUsd: round2(spikeDay.bucket.costUsd), limitUsd: options.dailyAlertUsd },
    });
  }

  if (prev7Complete && prev7.costUsd > 0 && last7.costUsd >= 1 && last7.costUsd > prev7.costUsd * 1.5) {
    alerts.push({
      code: 'week_rise',
      tone: 'warning',
      values: {
        last7Usd: round2(last7.costUsd),
        prev7Usd: round2(prev7.costUsd),
        risePct: Math.round((last7.costUsd / prev7.costUsd - 1) * 100),
      },
    });
  }

  if (unpriced30 > 0) {
    alerts.push({ code: 'unpriced_calls', tone: 'warning', values: { calls: unpriced30 } });
  }

  // The optimizer ran in the last 2 days but nothing reached the ledger: either
  // the migration is missing or metering is failing. Either way the numbers
  // below are a floor, not the truth.
  const recentRuns = runs.filter((run) => {
    const ms = Date.parse(run.started_at);
    return Number.isFinite(ms) && now - ms <= 2 * DAY_MS;
  });
  const recentLedgerRows = rows.filter((row) => {
    const ms = rowMs(row);
    return ms !== null && now - ms <= 2 * DAY_MS;
  });
  const recentModelCalls = recentRuns.reduce(
    (sum, run) => sum + (typeof run.details?.model_calls === 'number' ? num(run.details.model_calls) : 0),
    0
  );
  if (recentRuns.length > 0 && recentModelCalls > 0 && recentLedgerRows.length === 0) {
    alerts.push({ code: 'metering_gap', tone: 'danger', values: { runs: recentRuns.length, modelCalls: recentModelCalls } });
  }

  if (credit) {
    const danger = options.runwayDangerDays ?? 5;
    const warning = options.runwayWarningDays ?? 14;
    if (credit.runwayDays !== null && credit.runwayDays < danger) {
      alerts.push({ code: 'runway_critical', tone: 'danger', values: { days: credit.runwayDays, balanceUsd: credit.estimatedBalanceUsd } });
    } else if (credit.runwayDays !== null && credit.runwayDays < warning) {
      alerts.push({ code: 'runway_low', tone: 'warning', values: { days: credit.runwayDays, balanceUsd: credit.estimatedBalanceUsd } });
    }
    if (credit.promoExpired && credit.promoUsd > 0) {
      alerts.push({
        code: 'promo_expired',
        tone: 'info',
        values: { promoUsd: credit.promoUsd, balanceUsd: credit.estimatedBalanceUsd },
      });
    } else if (credit.daysToPromoExpiry !== null && credit.daysToPromoExpiry <= 30 && credit.promoUsd > 0) {
      alerts.push({
        code: 'promo_expiring',
        tone: credit.daysToPromoExpiry <= 14 ? 'warning' : 'info',
        values: {
          days: credit.daysToPromoExpiry,
          promoUsd: credit.promoUsd,
          paidAtExpiryUsd: credit.paidAtExpiryUsd ?? 0,
          paidRunwayDays: credit.paidRunwayDays ?? -1,
        },
      });
    }
    if (!credit.autoReload) {
      alerts.push({ code: 'auto_reload_off', tone: 'warning', values: {} });
    }
    if (credit.readAgeDays > (options.staleCreditDays ?? 14)) {
      alerts.push({ code: 'reading_stale', tone: 'info', values: { days: credit.readAgeDays } });
    }
  }

  const toneOrder = { danger: 0, warning: 1, info: 2 } as const;
  alerts.sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone]);

  return {
    generatedAt: now,
    today,
    firstRowDay,
    observedDays7,
    avgDailyDays: completeObserved,
    todaySpend: { costUsd: round6(todaySpend.costUsd), calls: todaySpend.calls },
    yesterday: { costUsd: round6(yesterdaySpend.costUsd), calls: yesterdaySpend.calls },
    last7: { costUsd: round6(last7.costUsd), calls: last7.calls, avgDailyUsd: round6(avgDaily7) },
    prev7: prev7Complete
      ? { costUsd: round6(prev7.costUsd), calls: prev7.calls, avgDailyUsd: round6(prev7.costUsd / 7) }
      : null,
    last30: { costUsd: round6(last30.costUsd), calls: last30.calls },
    monthToDate: { costUsd: round6(monthToDate.costUsd), calls: monthToDate.calls, dayOfMonth, daysInMonth },
    monthProjectionUsd: round2(monthProjection),
    next30DaysUsd: round2(avgDaily7 * 30),
    daily: days30.map((day) => {
      const bucket = byDay.get(day)!;
      return { day, costUsd: round6(bucket.costUsd), calls: bucket.calls, optimizerUsd: round6(bucket.optimizerUsd) };
    }),
    byFeature,
    byModel,
    cache: {
      readTokens: cache.read,
      writeTokens: cache.write,
      freshInputTokens: cache.fresh,
      hitRatio: totalInput > 0 ? cache.read / totalInput : null,
      netSavingUsd: round6(cache.netSaving),
    },
    optimizer: {
      runs7,
      runs30,
      failedRuns7,
      ledgerCalls7: optimizer.calls7,
      costUsd7: round6(optimizer.costUsd7),
      costPerCall7: costPerCall7 === null ? null : round6(costPerCall7),
      costPerRun7: costPerRun7 === null ? null : round6(costPerRun7),
      guardRuns7,
      skippedIdle7,
      cooledDown7,
      avoidedUsd7,
    },
    topUsers,
    unpricedCalls30: unpriced30,
    credit,
    alerts,
  };
}
