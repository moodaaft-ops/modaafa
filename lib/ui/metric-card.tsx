import Link from 'next/link';
import { ArrowUpLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'brand' | 'danger' | 'success' | 'dark';

const toneStyles: Record<Tone, { card: string; label: string; helper: string; bubble: string }> = {
  default: {
    card: 'border border-border bg-card',
    label: 'text-muted-foreground',
    helper: 'text-muted-foreground',
    bubble: 'bg-muted text-muted-foreground',
  },
  brand: {
    card: 'border border-brand-100 bg-brand-50 dark:border-brand-500/20 dark:bg-brand-500/10',
    label: 'text-brand-700 dark:text-brand-300',
    helper: 'text-brand-600/80 dark:text-brand-400/80',
    bubble: 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300',
  },
  success: {
    card: 'border border-emerald-100 bg-emerald-50 dark:border-emerald-500/20 dark:bg-emerald-500/10',
    label: 'text-emerald-700 dark:text-emerald-300',
    helper: 'text-emerald-600/80 dark:text-emerald-400/80',
    bubble: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  },
  danger: {
    card: 'border border-red-100 bg-red-50 dark:border-red-500/20 dark:bg-red-500/10',
    label: 'text-red-700 dark:text-red-300',
    helper: 'text-red-500 dark:text-red-400',
    bubble: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
  },
  dark: {
    card: 'bg-gradient-to-br from-ink-900 to-ink-800 text-white border border-white/5',
    label: 'text-white/70',
    helper: 'text-white/60',
    bubble: 'bg-white/10 text-white',
  },
};

/**
 * KPI / metric card: small label, large value, optional helper + icon bubble.
 * Becomes a link (with hover lift) when `href` is provided.
 */
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
        'relative flex h-full flex-col rounded-xl p-5 transition-all duration-200',
        styles.card,
        href && 'hover:-translate-y-0.5 hover:shadow-card',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-sm font-medium', styles.label)}>{label}</span>
        {Icon && (
          <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', styles.bubble)}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-bold break-words tabular-nums">{value}</div>
      {helper && <div className={cn('mt-1.5 text-xs', styles.helper)}>{helper}</div>}
      {href && (
        <ArrowUpLeft
          className={cn('absolute bottom-4 end-4 h-4 w-4 opacity-0 transition group-hover:opacity-100', styles.helper)}
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
