'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';

/**
 * Per-campaign spend distribution (last 7 days), coloured by ROAS.
 *
 * A hand-built CSS bar chart rather than a charting library: the cache stores
 * 7d/30d aggregates (no daily series), horizontal bars are all this data wants,
 * and this keeps ~100 kB of recharts out of the dashboard bundle while staying
 * fully token-driven, RTL-native, and animated on mount.
 */

type Row = { id?: string | number; name: string; spend: number; roas: number };

export function CampaignSpendChart({
  campaigns,
  currencyCode,
}: {
  campaigns: Row[];
  currencyCode?: string | null;
}) {
  const [grown, setGrown] = useState(false);

  const data = campaigns
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 6);

  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (data.length === 0) return null;
  const max = Math.max(...data.map((c) => c.spend)) || 1;

  return (
    <section className="surface-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h3 className="text-[14px] font-semibold">توزيع الإنفاق حسب الحملة</h3>
          {/* Latin digits, matching the app-wide numerals policy in
              lib/utils.ts — an Eastern-Arabic ٧ next to Latin-digit money is
              exactly the mixed-numeral screen that policy eliminated. */}
          <p className="mt-1 text-xs text-muted-foreground">آخر 7 أيام — أعلى {data.length} حملات إنفاقاً</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-primary" aria-hidden />
            ROAS ≥ 1×
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" aria-hidden />
            دون الهدف
          </span>
        </div>
      </div>

      <ul className="space-y-3.5 p-5">
        {data.map((row, index) => {
          const pct = Math.max(3, (row.spend / max) * 100);
          const healthy = row.roas >= 1;
          return (
            // Key by id when present (two campaigns can share a name — common
            // with copied campaigns — and a duplicate React key drops a bar);
            // fall back to name+index otherwise.
            <li key={row.id ?? `${row.name}-${index}`}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{row.name}</span>
                <span className="flex-shrink-0 text-[12px] text-muted-foreground">
                  <span className="numeric font-semibold text-foreground">
                    {formatCurrency(row.spend, currencyCode)}
                  </span>
                  <span className="mx-1.5 text-border-strong">·</span>
                  <span className="numeric">ROAS {row.roas.toFixed(1)}×</span>
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-[width] duration-700 ease-snap ${
                    healthy ? 'bg-primary' : 'bg-amber-500'
                  }`}
                  style={{ width: grown ? `${pct}%` : '0%' }}
                  aria-hidden
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
