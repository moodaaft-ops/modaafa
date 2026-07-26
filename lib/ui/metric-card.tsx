import Link from 'next/link';
import { ArrowUpLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'brand' | 'danger' | 'success' | 'dark';

/**
 * KPI card.
 *
 * All tones share one surface. Colour is carried by the label, the icon and a
 * hairline accent rule at the top — not by a pastel fill, which on a near-black
 * canvas turns into an unreadable smudge and makes a row of KPIs look like a
 * bag of sweets rather than an instrument panel.
 */
const toneStyles: Record<Tone, { accent: string; label: string; bubble: string; value: string }> = {
  default: {
    accent: 'bg-border-strong',
    label: 'text-muted-foreground',
    bubble: 'bg-muted text-muted-foreground',
    value: 'text-foreground',
  },
  brand: {
    accent: 'bg-primary',
    label: 'text-primary',
    bubble: 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/25',
    value: 'text-foreground',
  },
  success: {
    accent: 'bg-emerald-500',
    label: 'text-emerald-600 dark:text-emerald-400',
    bubble: 'bg-emerald-500/12 text-emerald-600 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-400',
    value: 'text-foreground',
  },
  danger: {
    accent: 'bg-red-500',
    label: 'text-red-600 dark:text-red-400',
    bubble: 'bg-red-500/12 text-red-600 ring-1 ring-inset ring-red-500/25 dark:text-red-400',
    value: 'text-foreground',
  },
  dark: {
    accent: 'bg-foreground/40',
    label: 'text-muted-foreground',
    bubble: 'bg-foreground/10 text-foreground',
    value: 'text-foreground',
  },
};

export function MetricCard({
  label,
  value,
  helper,
  icon: Icon,
  tone = 'default',
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  helper?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  href?: string;
  className?: string;
}) {
  const styles = toneStyles[tone];
  const inner = (
    <div
      className={cn(
        'surface-card surface-interactive relative flex h-full flex-col overflow-hidden p-4 sm:p-5',
        className
      )}
    >
      <span className={cn('absolute inset-x-0 top-0 h-px', styles.accent)} aria-hidden />

      <div className="flex items-start justify-between gap-2">
        <span className={cn('text-[13px] font-medium', styles.label)}>{label}</span>
        {Icon && (
          <span className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md', styles.bubble)}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      <div className={cn('mt-3 break-words text-[1.75rem] font-bold leading-none numeric', styles.value)}>
        {value}
      </div>

      {/* Reserve the helper line so a row of cards keeps a common baseline. */}
      <div className="mt-2 min-h-[1.25rem] text-xs leading-5 text-muted-foreground">{helper}</div>

      {href && (
        <ArrowUpLeft
          className="absolute bottom-4 end-4 h-4 w-4 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          aria-hidden
        />
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="group block h-full">
        {inner}
      </Link>
    );
  }
  return inner;
}

/**
 * Compact figure used inside panels where a full KPI card would be too heavy.
 */
export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-bold leading-tight numeric">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
