import type { EvidenceRow, JarvisReadTool } from './types';
import {
  currencyUnits,
  lastFullDaysUtc,
  money,
  moneyOrNull,
  num,
  num0,
  okResult,
  parseArgs,
  pct1,
  ratio,
  refCounter,
  round,
  runQuery,
  safeCurrency,
  str,
} from './shared';

const WINDOW_DAYS = 28;
const LOW_VOLUME_CONVERSIONS = 30;
/** Saudi week order. */
const DAYS = ['SATURDAY', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const;
const BANDS = [
  { id: '00-05', from: 0 },
  { id: '06-11', from: 6 },
  { id: '12-17', from: 12 },
  { id: '18-23', from: 18 },
] as const;

type Bucket = { clicks: number; cost: number; conversions: number };
const emptyBucket = (): Bucket => ({ clicks: 0, cost: 0, conversions: 0 });

function add(bucket: Bucket, clicks: number, cost: number, conversions: number) {
  bucket.clicks += clicks;
  bucket.cost += cost;
  bucket.conversions += conversions;
}

export const getScheduleTool: JarvisReadTool = {
  name: 'get_schedule',
  description:
    'Aggregates the last 28 full days (today excluded) by day of week and by six hour band, so every weekday is counted four times. Use it to spot days or hours that burn budget without converting; when conversions are under 30 the differences may be chance and the result says so.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);
    const { from, to } = lastFullDaysUtc(ctx.now, WINDOW_DAYS);

    const rows = await runQuery(
      ctx,
      `
      SELECT segments.day_of_week, segments.hour,
        metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}' AND campaign.status = 'ENABLED'
    `
    );

    const byDay = new Map<string, Bucket>(DAYS.map((day) => [day, emptyBucket()]));
    const byBand = BANDS.map(() => emptyBucket());
    const cells = new Map<string, Bucket & { day: string; band: string }>();
    const total = emptyBucket();

    for (const row of rows) {
      const day = str(row, 'segments.day_of_week');
      const hour = num(row, 'segments.hour');
      const dayBucket = byDay.get(day);
      if (!dayBucket || hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const bandIndex = Math.floor(hour / 6);
      const clicks = num0(row, 'metrics.clicks');
      const cost = currencyUnits(row, 'metrics.cost_micros');
      const conversions = num0(row, 'metrics.conversions');

      add(dayBucket, clicks, cost, conversions);
      add(byBand[bandIndex], clicks, cost, conversions);
      add(total, clicks, cost, conversions);
      const cellKey = `${day}|${BANDS[bandIndex].id}`;
      const cell = cells.get(cellKey) ?? { ...emptyBucket(), day, band: BANDS[bandIndex].id };
      add(cell, clicks, cost, conversions);
      cells.set(cellKey, cell);
    }

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];

    const slot = (data: Record<string, unknown>, bucket: Bucket) => {
      const ref = nextRef('slot');
      const compact = {
        ...data,
        clicks: bucket.clicks,
        cost: money(bucket.cost),
        conversions: round(bucket.conversions, 2),
        cpa: moneyOrNull(ratio(bucket.cost, bucket.conversions)),
        cost_share_pct: pct1(ratio(bucket.cost, total.cost)),
      };
      evidence.push({ ref, kind: 'schedule_slot', data: { ...compact } });
      return { ref, ...compact };
    };

    const dayRows = DAYS.map((day) => slot({ dimension: 'day', day }, byDay.get(day) ?? emptyBucket()));
    const bandRows = BANDS.map((band, index) => slot({ dimension: 'band', band: band.id }, byBand[index]));

    const allCells = [...cells.values()];
    const weakCells = allCells
      .filter((cell) => cell.cost > 0 && cell.conversions <= 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5)
      .map((cell) => slot({ dimension: 'cell', day: cell.day, band: cell.band }, cell));
    const bestCells = allCells
      .filter((cell) => cell.conversions > 0)
      .sort((a, b) => b.conversions - a.conversions || a.cost - b.cost)
      .slice(0, 5)
      .map((cell) => slot({ dimension: 'cell', day: cell.day, band: cell.band }, cell));

    const lowVolume = total.conversions < LOW_VOLUME_CONVERSIONS;
    return okResult(
      {
        range: { from, to, days: WINDOW_DAYS },
        currency: safeCurrency(ctx),
        totals: {
          clicks: total.clicks,
          cost: money(total.cost),
          conversions: round(total.conversions, 2),
          cpa: moneyOrNull(ratio(total.cost, total.conversions)),
        },
        low_volume: lowVolume,
        ...(lowVolume
          ? { warning_ar: 'التحويلات في آخر 28 يوم قليلة (أقل من 30)، فالفروقات بين الأيام والساعات ممكن تكون صدفة' }
          : {}),
        by_day: dayRows,
        by_hour_band: bandRows,
        weak_cells: weakCells,
        best_cells: bestCells,
      },
      evidence
    );
  },
};
