import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Status pill. Always pairs colour with a dot/text label so colour is never the
 * only signal (accessibility requirement).
 */
// 
// flat pastel fill disappears; the ring is what makes the chip read as an
// object rather than a smudge.
const badge = cva(
  'inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold leading-5 whitespace-nowrap ring-1 ring-inset',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground ring-border-strong',
        success: 'bg-success/12 text-success ring-success/25 dark:text-success',
        warning: 'bg-warning/12 text-warning ring-warning/25 dark:text-warning',
        danger: 'bg-danger/12 text-danger ring-danger/25 dark:text-danger',
        info: 'bg-info/12 text-info ring-info/25 dark:text-info',
        brand: 'bg-primary/12 text-primary ring-primary/30',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
);

const dotColor: Record<NonNullable<VariantProps<typeof badge>['tone']>, string> = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  brand: 'bg-primary',
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
        <span className={cn('status-square', dotColor[tone])} aria-hidden />
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
