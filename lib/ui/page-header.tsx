import { Building2 } from 'lucide-react';
import { formatGoogleAdsCustomerId } from '@/lib/accounts/display';
import { cn } from '@/lib/utils';

/**
 * Sticky page header used on every dashboard route.
 *
 * Deliberately quiet: a translucent blurred bar with a single fading hairline
 * underneath, no icon tile and no card chrome. The header is a frame for the
 * page, not a component competing with it.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  account,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  account?: { name: string; customerId?: string | null } | null;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'sticky top-0 z-30 bg-background/70 px-4 pb-3 pt-4 backdrop-blur-xl sm:px-6 lg:px-8',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <Icon className="hidden h-[18px] w-[18px] flex-shrink-0 text-muted-foreground sm:block" aria-hidden />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[1.0625rem] font-semibold tracking-tight text-foreground sm:text-lg">
              {title}
            </h1>
            {description && (
              <p className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        {(actions || account) && (
          <div className="flex flex-wrap items-center gap-2">
            {account && <AccountPill name={account.name} customerId={account.customerId} />}
            {actions}
          </div>
        )}
      </div>

      <div className="rule-fade mt-3 h-px" aria-hidden />
    </header>
  );
}

/** Compact pill showing which ad account the page's data belongs to. */
export function AccountPill({ name, customerId }: { name: string; customerId?: string | null }) {
  return (
    <span className="inline-flex max-w-[220px] items-center gap-2 surface-card px-2.5 py-1.5 shadow-soft">
      <Building2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-semibold text-foreground">{name}</span>
        {customerId && (
          <span className="block text-[10px] text-muted-foreground numeric" dir="ltr">
            {formatGoogleAdsCustomerId(customerId)}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * Section heading inside a page body. Gives panels a consistent title rhythm
 * without wrapping them in yet another card.
 */
export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
