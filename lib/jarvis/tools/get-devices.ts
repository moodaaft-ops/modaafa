import type { EvidenceRow, JarvisReadTool } from './types';
import {
  currencyUnits,
  enumLabel,
  money,
  moneyOrNull,
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

type DeviceTotals = { clicks: number; cost: number; conversions: number; value: number };

export const getDevicesTool: JarvisReadTool = {
  name: 'get_devices',
  description:
    'Splits the last 30 days of enabled campaigns by device (mobile, desktop, tablet, other) with spend, conversions, CPA and ROAS. Use it to check whether one device eats budget without converting.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    parseArgs(input, []);

    const rows = await runQuery(
      ctx,
      `
      SELECT segments.device, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'
    `
    );

    const devices = new Map<string, DeviceTotals>();
    const total: DeviceTotals = { clicks: 0, cost: 0, conversions: 0, value: 0 };
    for (const row of rows) {
      const device = enumLabel(str(row, 'segments.device'), 'OTHER');
      const entry = devices.get(device) ?? { clicks: 0, cost: 0, conversions: 0, value: 0 };
      const clicks = num0(row, 'metrics.clicks');
      const cost = currencyUnits(row, 'metrics.cost_micros');
      const conversions = num0(row, 'metrics.conversions');
      const value = num0(row, 'metrics.conversions_value');
      for (const bucket of [entry, total]) {
        bucket.clicks += clicks;
        bucket.cost += cost;
        bucket.conversions += conversions;
        bucket.value += value;
      }
      devices.set(device, entry);
    }

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const list = [...devices.entries()]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([device, entry]) => {
        const ref = nextRef('dev');
        const compact = {
          device,
          clicks: entry.clicks,
          cost: money(entry.cost),
          conversions: round(entry.conversions, 2),
          conv_value: money(entry.value),
          cpa: moneyOrNull(ratio(entry.cost, entry.conversions)),
          roas: moneyOrNull(ratio(entry.value, entry.cost)),
          cost_share_pct: pct1(ratio(entry.cost, total.cost)),
          conversion_share_pct: pct1(ratio(entry.conversions, total.conversions)),
        };
        evidence.push({ ref, kind: 'device', data: { ...compact } });
        return { ref, ...compact };
      });

    return okResult(
      {
        period: 'LAST_30_DAYS',
        currency: safeCurrency(ctx),
        totals: {
          clicks: total.clicks,
          cost: money(total.cost),
          conversions: round(total.conversions, 2),
          conv_value: money(total.value),
          cpa: moneyOrNull(ratio(total.cost, total.conversions)),
          roas: moneyOrNull(ratio(total.value, total.cost)),
        },
        devices: list,
      },
      evidence
    );
  },
};
