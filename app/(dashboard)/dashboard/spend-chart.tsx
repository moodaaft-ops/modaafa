import { formatCurrency, formatNumberAr } from '@/lib/utils';

/**
 * Per-campaign spend distribution for the selected date range.
 *
 * A plain CSS bar list rather than a charting library: the cache stores 7d/30d
 * aggregates (no daily series), horizontal bars are all this data wants, and it
 * keeps a chart dependency out of the dashboard bundle. One colour on purpose:
 * the bar length carries the information, and the signal yellow is reserved for
 * the decision block.
 */

type Row = { id?: string | number; name: string; spend: number };

export function CampaignSpendChart({
  campaigns,
  currencyCode,
  rangeLabel,
  totalSpend,
}: {
  campaigns: Row[];
  currencyCode?: string | null;
  rangeLabel: string;
  totalSpend: number;
}) {
  const data = campaigns
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 6);

  if (data.length === 0) return null;
  const max = Math.max(...data.map((c) => c.spend)) || 1;

  return (
    <section className="surface-card overflow-hidden">
      <div className="border-b border-border px-4 py-4 sm:px-5">
        <h2 className="text-[14px] font-semibold">توزيع الإنفاق حسب الحملة</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {rangeLabel} · الحملات الأعلى إنفاقاً
        </p>
      </div>

      <ul className="space-y-3.5 p-4 sm:p-5">
        {data.map((row, index) => {
          const pct = Math.max(3, (row.spend / max) * 100);
          const share = totalSpend > 0 ? Math.round((row.spend / totalSpend) * 100) : 0;
          return (
            // Key by id when present: two campaigns can share a name (common
            // with copied campaigns) and a duplicate key drops a bar.
            <li key={row.id ?? `${row.name}-${index}`}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{row.name}</span>
                <span className="flex-shrink-0 text-[12px] text-muted-foreground">
                  <span className="font-mono numeric font-semibold text-foreground">
                    {formatCurrency(row.spend, currencyCode)}
                  </span>
                  <span className="mx-1.5 text-border-strong" aria-hidden>
                    ·
                  </span>
                  <span className="font-mono numeric">{formatNumberAr(share)}%</span>
                </span>
              </div>
              <div className="h-2 w-full bg-muted" aria-hidden>
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
