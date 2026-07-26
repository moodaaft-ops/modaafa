import { cn } from '@/lib/utils';

/**
 * Standard white content panel with an optional header (title, description,
 * actions). Use `flush` to drop padding for tables / divided lists.
 */
export function SectionPanel({
  title,
  description,
  icon: Icon,
  actions,
  children,
  flush = false,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHeader = title || description || actions;
  return (
    <section className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      {hasHeader && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
          <div className="flex min-w-0 items-start gap-3">
            {Icon && (
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="h-5 w-5" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="font-bold text-foreground">{title}</h2>}
              {description && <p className="mt-1 text-xs leading-6 text-muted-foreground">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && 'p-6', bodyClassName)}>{children}</div>
    </section>
  );
}
