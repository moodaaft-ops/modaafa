import { cn } from '@/lib/utils';

/**
 * Actionable empty state: icon + specific title + explanation + a clear next
 * action. Renders its own panel by default; pass `bare` to drop into an
 * existing panel.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'brand',
  bare = false,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'brand' | 'neutral' | 'warning';
  bare?: boolean;
  className?: string;
}) {
  const bubble =
    tone === 'warning'
      ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
      : tone === 'neutral'
        ? 'bg-muted text-muted-foreground'
        : 'bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400';

  return (
    <div
      className={cn(
        'flex flex-col items-center px-6 py-12 text-center',
        !bare && 'rounded-lg border border-border bg-card',
        className
      )}
    >
      {Icon && (
        <span className={cn('mb-4 flex h-14 w-14 items-center justify-center rounded-lg', bubble)}>
          <Icon className="h-7 w-7" />
        </span>
      )}
      <h3 className="text-lg font-bold text-foreground">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-7 text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
