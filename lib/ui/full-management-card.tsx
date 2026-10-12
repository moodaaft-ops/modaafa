import { ArrowUpLeft } from 'lucide-react';
import { FULL_MANAGEMENT_COPY as copy, fullManagementHref } from '@/lib/growth/full-management';

/**
 * Shown on the audit result. A quiet second path under the main next step, not
 * a banner above it: the person came to fix the account, and the offer only
 * has to be there for the one who does not have the time.
 */
export function FullManagementCard() {
  return (
    <section
      aria-labelledby="full-management-title"
      className="surface-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
    >
      <div className="min-w-0">
        <h2 id="full-management-title" className="text-[15px] font-bold text-foreground">
          {copy.heading}
        </h2>
        <p className="mt-1.5 max-w-3xl text-sm leading-7 text-muted-foreground">{copy.body}</p>
        <p className="mt-1 text-[13px] leading-7 text-muted-foreground">{copy.selfServe}</p>
      </div>
      <a
        href={fullManagementHref('audit_result')}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 flex-shrink-0 items-center justify-center gap-2 border border-border-strong px-4 text-sm font-semibold text-foreground transition-colors hover:border-foreground hover:bg-surface"
      >
        {copy.button}
        <ArrowUpLeft className="h-4 w-4" aria-hidden />
      </a>
    </section>
  );
}
