import { cn } from '@/lib/utils';

/**
 * One definition of what an input looks like.
 *
 * Before this, every form re-declared its own class string — settings used
 * `h-10 rounded-lg border border-border`, onboarding used `h-11 … transition`,
 * the audit page's account picker used a third variant, and the danger-zone
 * confirmation used a fourth. They disagreed on height, focus treatment and
 * background, so the product read as several products stitched together.
 *
 * The focus treatment is a ring rather than a colour swap: on a dark canvas a
 * border-colour change alone is nearly invisible, and keyboard users could not
 * tell which field they were in.
 */
export const inputClasses = cn(
  'h-11 w-full rounded-lg border border-border bg-background-elevated px-3.5 text-sm text-foreground',
  'placeholder:text-foreground-subtle',
  'outline-none transition-[border-color,box-shadow] duration-150',
  'hover:border-border-strong',
  'focus:border-primary/70 focus:ring-4 focus:ring-primary/15',
  'disabled:cursor-not-allowed disabled:opacity-60'
);

/** Same treatment for <select>, minus the placeholder rule. */
export const selectClasses = cn(
  'h-11 w-full rounded-lg border border-border bg-background-elevated px-3 text-sm text-foreground',
  'outline-none transition-[border-color,box-shadow] duration-150',
  'hover:border-border-strong',
  'focus:border-primary/70 focus:ring-4 focus:ring-primary/15'
);

/** Same treatment for a multi-line field. */
export const textareaClasses = cn(
  'w-full rounded-lg border border-border bg-background-elevated px-3.5 py-3 text-sm leading-7 text-foreground',
  'placeholder:text-foreground-subtle',
  'outline-none transition-[border-color,box-shadow] duration-150',
  'hover:border-border-strong',
  'focus:border-primary/70 focus:ring-4 focus:ring-primary/15'
);

/**
 * Labelled form row. `error` renders the message under the field and is
 * wired to the control through aria-describedby by the caller when needed.
 */
export function Field({
  label,
  hint,
  required,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-2 flex flex-wrap items-baseline gap-x-1.5 text-[13px] font-medium text-foreground">
        <span>
          {label}
          {required && (
            <span className="text-red-500" aria-hidden>
              {' '}
              *
            </span>
          )}
        </span>
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      {/* When there is an error the control itself must show it, not just the
          text underneath — a red sentence below a neutral-bordered input reads
          as a general warning rather than "this field". The descendant
          selector means callers keep passing plain `inputClasses` and don't
          have to thread error state into every control. */}
      <span
        className={cn(
          'block',
          error && '[&_input]:border-red-500/60 [&_select]:border-red-500/60 [&_textarea]:border-red-500/60'
        )}
      >
        {children}
      </span>
      {error && (
        <span className="mt-2 block text-xs font-medium text-red-500" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
