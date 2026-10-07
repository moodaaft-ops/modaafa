import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared button style. Use `buttonClasses(...)` on <a>/<Link>/<button>, or the
 * <Button> component for plain buttons.
 *
 * Design notes: flat, sharp-cornered controls. Primary is solid navy (paper in
 * dark); signal yellow is reserved for highlights and never fills a control.
 */
export const buttonClasses = cva(
  'inline-flex items-center justify-center gap-2 font-semibold select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-snap active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-wait',
  {
    variants: {
      variant: {
        // Solid accent. Not a gradient: gradients on small controls read cheap
        // and make the contrast ratio unverifiable.
        primary:
          'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'bg-foreground text-background hover:bg-foreground/88',
        outline:
          'border border-border bg-card text-foreground hover:border-border-strong hover:bg-surface',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        subtle:
          'border border-primary/30 bg-transparent text-primary hover:border-primary hover:bg-muted',
        danger:
          'bg-danger text-background hover:bg-danger/90',
        'danger-outline':
          'border border-danger/30 bg-card text-danger hover:border-danger/50 hover:bg-danger/10 dark:text-danger',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-[0.9375rem]',
        icon: 'h-9 w-9 p-0',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  }
);

export type ButtonVariantProps = VariantProps<typeof buttonClasses>;

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  ButtonVariantProps & {
    loading?: boolean;
    loadingLabel?: string;
  };

export function Button({
  variant,
  size,
  block,
  loading,
  loadingLabel,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses({ variant, size, block }), className)}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

/**
 * Keyboard hint / inline code chip, e.g. a customer id or a shortcut.
 * Latin content only — always pass dir="ltr" content.
 */
export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      dir="ltr"
      className={cn(
        'inline-flex items-center border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground numeric',
        className
      )}
    >
      {children}
    </span>
  );
}
