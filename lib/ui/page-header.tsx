import { Building2 } from 'lucide-react';
import { formatGoogleAdsCustomerId } from '@/lib/accounts/display';
import { cn } from '@/lib/utils';

/**
 * Consistent sticky page header used across every dashboard route.
 * Shows the page title, an optional description, the active-account context,
 * and a slot for the page's primary action.
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
        'sticky top-0 z-30 border-b border-border bg-card/85 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8 lg:py-4',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          {Icon && (
            <span className="hidden h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300 sm:flex">
              <Icon className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-foreground sm:text-xl">{title}</h1>
            {description && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
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
    </header>
  );
}

/** Compact pill showing which ad account the page's data belongs to. */
export function AccountPill({
  name,
  customerId,
}: {
  name: string;
  customerId?: string | null;
}) {
  return (
    <span className="inline-flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5">
      <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-semibold text-foreground">{name}</span>
        {customerId && (
          <span className="block text-[11px] text-muted-foreground" dir="ltr">
            {formatGoogleAdsCustomerId(customerId)}
          </span>
        )}
      </span>
    </span>
  );
}
