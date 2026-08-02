import { cn } from '@/lib/utils';

/**
 * Actionable empty state: icon + specific title + explanation + a clear next
 * action. Renders its own panel by default; pass `bare` to drop into an
 * existing panel.
 *
 * The icon sits in a bordered tile over a faint radial glow so the block has
 * presence on a dark canvas without needing a heavy fill.
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
  const tile =
    tone === 'warning'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-500'
      : tone === 'neutral'
        ? 'border-border-strong bg-muted text-muted-foreground'
        : 'border-primary/25 bg-primary/10 text-primary';

  return (
    <div
      className={cn(
        'relative flex flex-col items-center overflow-hidden px-6 py-14 text-center',
        !bare && 'surface-card',
        className
      )}
    >
      {!bare && <div className="canvas-glow pointer-events-none absolute inset-0 opacity-60" aria-hidden />}

      <div className="relative">
        {Icon && (
          <span className={cn('mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border', tile)}>
            <Icon className="h-5 w-5" />
          </span>
        )}
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-7 text-muted-foreground">{description}</p>
        )}
        {action && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}</div>
        )}
      </div>
    </div>
  );
}
