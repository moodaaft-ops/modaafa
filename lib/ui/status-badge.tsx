import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Status pill. Always pairs colour with a dot/text label so colour is never the
 * only signal (accessibility requirement).
 */
const badge = cva(
  'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold leading-5 whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        danger: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
        info: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
        brand: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
);

const dotColor: Record<NonNullable<VariantProps<typeof badge>['tone']>, string> = {
  neutral: 'bg-ink-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
  brand: 'bg-brand-500',
};

export type StatusTone = NonNullable<VariantProps<typeof badge>['tone']>;

export function StatusBadge({
  tone = 'neutral',
  dot = true,
  icon: Icon,
  className,
  children,
}: {
  tone?: StatusTone;
  dot?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn(badge({ tone }), className)}>
      {Icon ? (
        <Icon className="h-3.5 w-3.5" />
      ) : dot ? (
        <span className={cn('h-1.5 w-1.5 rounded-full', dotColor[tone])} aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

/** Map a Google Ads campaign status to a tone. */
export function campaignStatusTone(status?: string | null): StatusTone {
  switch (status) {
    case 'ENABLED':
      return 'success';
    case 'PAUSED':
      return 'neutral';
    case 'REMOVED':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Map an audit severity to a tone. */
export function severityTone(severity?: string | null): StatusTone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'medium':
      return 'warning';
    case 'growth':
      return 'success';
    default:
      return 'neutral';
  }
}

/** Map a recommendation status to a tone. */
export function recommendationStatusTone(status?: string | null): StatusTone {
  switch (status) {
    case 'approved':
      return 'brand';
    case 'executing':
      return 'info';
    case 'applied':
      return 'success';
    case 'dismissed':
      return 'neutral';
    case 'failed':
      return 'danger';
    default:
      return 'warning';
  }
}
