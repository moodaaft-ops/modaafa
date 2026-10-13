import { formatGoogleAdsCustomerId } from '@/lib/accounts/display';
import { inputClasses } from '@/lib/ui/field';
import { cn } from '@/lib/utils';

/**
 * The few shared pieces of the four plain pages (حملاتي، التقارير، الاشتراك،
 * الإعدادات) inside the simple shell. Same look as the home: one centred
 * column, hairline cards with 18px corners, pill buttons, plain text where a
 * box would add nothing. Kept local on purpose: lib/ui is still used by the
 * old screens, which keep their flat identity.
 */

/** The one column. Campaigns is the only page that gets the wider one (a real table). */
export function CalmPage({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-4 pb-24 pt-6 sm:px-6 sm:pt-10 lg:pb-16',
        wide ? 'max-w-[1040px]' : 'max-w-[760px]'
      )}
    >
      {children}
    </div>
  );
}

/** Calm page title: the name, one muted line under it, and the ad account as plain text. */
export function CalmTitle({
  title,
  description,
  account,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  account?: { name: string; customerId?: string | null } | null;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[24px] font-bold leading-10 text-foreground sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-[14.5px] leading-7 text-muted-foreground">{description}</p>}
        {account && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] leading-6 text-muted-foreground">
            <span className="font-medium text-foreground">{account.name}</span>
            {account.customerId && (
              <span className="numeric" dir="ltr">
                {formatGoogleAdsCustomerId(account.customerId)}
              </span>
            )}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A heading inside the page body, with an optional line under it and an optional action at the end. */
export function CalmHeading({
  id,
  title,
  hint,
  action,
  className,
}: {
  id?: string;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-[16px] font-bold leading-8 text-foreground">{title}</h2>
        {hint && <p className="text-[13.5px] leading-6 text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

type NoteTone = 'success' | 'danger' | 'warning' | 'info';

const NOTE_TONES: Record<NoteTone, string> = {
  success: 'bg-success-soft text-foreground',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-muted text-foreground',
};

/** A notice line, like the one on the home: a soft fill, no border, no icon tile. */
export function CalmNote({ tone = 'info', children }: { tone?: NoteTone; children: React.ReactNode }) {
  return (
    <p
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('rounded-[14px] px-4 py-3 text-[14px] font-medium leading-7', NOTE_TONES[tone])}
    >
      {children}
    </p>
  );
}

/** Empty state: plain text on the page, the next step as a pill. No icon tile, no box. */
export function CalmEmpty({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[460px] px-2 py-14 text-center sm:py-20">
      <h2 className="text-[19px] font-semibold leading-9 text-foreground">{title}</h2>
      {description && <p className="mt-2 text-[14.5px] leading-8 text-muted-foreground">{description}</p>}
      {children && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}

export type DotTone = 'success' | 'neutral' | 'warning' | 'danger' | 'brand';

const DOT_TONES: Record<DotTone, string> = {
  success: 'bg-success',
  neutral: 'bg-muted-foreground',
  warning: 'bg-warning',
  danger: 'bg-danger',
  brand: 'bg-foreground',
};

/** A status as a round dot and a word. The word carries the meaning, the dot only helps the eye. */
export function StatusWord({ tone = 'neutral', children }: { tone?: DotTone; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13.5px] font-medium text-foreground">
      <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', DOT_TONES[tone])} aria-hidden />
      {children}
    </span>
  );
}

/** A small rounded tag next to a title («خطتك الحالية», «الأنسب»). */
export function Tag({ tone = 'neutral', children }: { tone?: 'neutral' | 'strong'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold',
        tone === 'strong' ? 'bg-foreground text-background' : 'bg-muted text-foreground'
      )}
    >
      {children}
    </span>
  );
}

/** Hairline card, same corner and border as the cards on the home. */
export const CARD = 'rounded-[18px] border border-border/80 bg-card';

const PILL_BASE =
  'inline-flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-60 aria-busy:cursor-wait';

/** Buttons and links that look like buttons. Pass the result to className. */
export const pill = {
  primary: cn(PILL_BASE, 'min-h-10 bg-primary px-5 text-primary-foreground hover:bg-primary/90'),
  quiet: cn(PILL_BASE, 'min-h-10 border border-border bg-card px-5 text-foreground hover:bg-muted'),
  danger: cn(PILL_BASE, 'min-h-10 bg-danger px-5 text-background hover:bg-danger/90'),
  dangerQuiet: cn(PILL_BASE, 'min-h-10 border border-danger/30 bg-card px-5 text-danger hover:bg-danger/10'),
  primarySm: cn(PILL_BASE, 'min-h-9 bg-primary px-4 text-[13.5px] text-primary-foreground hover:bg-primary/90'),
  quietSm: cn(PILL_BASE, 'min-h-9 border border-border bg-card px-4 text-[13.5px] text-foreground hover:bg-muted'),
};

/** Text field: the shared field, with the pill shape of the home's composer. */
export const FIELD = cn(inputClasses, 'rounded-full px-5');
