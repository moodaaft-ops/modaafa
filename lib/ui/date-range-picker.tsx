'use client';

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, Loader2 } from 'lucide-react';
import {
  DATE_RANGE_PRESETS,
  validateCustomDateRange,
  type DateRangeKey,
  type DateRangeSelection,
} from '@/lib/analytics/date-range';
import { buttonClasses } from '@/lib/ui/button';
import { inputClasses } from '@/lib/ui/field';
import { cn } from '@/lib/utils';

export function DateRangePicker({
  selection,
  className,
}: {
  selection: DateRangeSelection;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedKey = searchParams.get('range');
  const [customOpen, setCustomOpen] = useState(
    selection.key === 'custom' || requestedKey === 'custom'
  );
  const [from, setFrom] = useState(searchParams.get('from') ?? selection.from);
  const [to, setTo] = useState(searchParams.get('to') ?? selection.to);
  const [clientError, setClientError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const currentKey = searchParams.get('range');
    const currentFrom = searchParams.get('from');
    const currentTo = searchParams.get('to');
    setCustomOpen(currentKey === 'custom');
    if (currentFrom) setFrom(currentFrom);
    if (currentTo) setTo(currentTo);
    setClientError(null);
  }, [searchParams]);

  function navigate(key: DateRangeKey, customFrom?: string, customTo?: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set('range', key);
    next.delete('from');
    next.delete('to');
    if (key === 'custom' && customFrom && customTo) {
      next.set('from', customFrom);
      next.set('to', customTo);
    }
    next.delete('synced');
    next.delete('sync_error');
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  function choosePreset(key: DateRangeKey) {
    setClientError(null);
    setCustomOpen(false);
    navigate(key);
  }

  function applyCustomRange() {
    const validation = validateCustomDateRange(from, to);
    if (!validation.ok) {
      setClientError(validation.error);
      return;
    }
    setClientError(null);
    navigate('custom', validation.from, validation.to);
  }

  const displayedError = clientError ?? selection.error;

  return (
    <section
      aria-label="اختيار فترة التقرير"
      className={cn(
        'rounded-lg border border-border bg-card px-4 py-3.5 shadow-soft',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-foreground">فترة التقرير</h2>
            <p className="truncate text-[11.5px] text-muted-foreground">{selection.label}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted/60 p-1" role="group" aria-label="الفترات السريعة">
            {DATE_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                disabled={isPending}
                aria-pressed={!customOpen && selection.key === preset.key}
                onClick={() => choosePreset(preset.key)}
                className={cn(
                  'h-8 rounded-md px-3 text-xs font-semibold transition-colors disabled:opacity-50',
                  !customOpen && selection.key === preset.key
                    ? 'bg-card text-foreground shadow-soft'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              disabled={isPending}
              aria-pressed={customOpen}
              onClick={() => {
                setClientError(null);
                setCustomOpen(true);
              }}
              className={cn(
                'h-8 rounded-md px-3 text-xs font-semibold transition-colors disabled:opacity-50',
                customOpen
                  ? 'bg-card text-foreground shadow-soft'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              فترة مخصصة
            </button>
          </div>

          {isPending && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              جاري تحميل الفترة...
            </span>
          )}
        </div>
      </div>

      {customOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <label className="min-w-[150px] flex-1 sm:max-w-[220px]">
            <span className="mb-1.5 block text-xs font-medium text-foreground">من تاريخ</span>
            <input
              dir="ltr"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClasses}
            />
          </label>
          <label className="min-w-[150px] flex-1 sm:max-w-[220px]">
            <span className="mb-1.5 block text-xs font-medium text-foreground">إلى تاريخ</span>
            <input
              dir="ltr"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={inputClasses}
            />
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={applyCustomRange}
            className={buttonClasses({ variant: 'primary' })}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            تطبيق الفترة
          </button>
        </div>
      )}

      {displayedError && (
        <p className="mt-2.5 text-xs font-medium text-red-600 dark:text-red-300" role="alert">
          {displayedError}
        </p>
      )}
    </section>
  );
}
