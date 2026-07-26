import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared button style. Use `buttonClasses(...)` on <a>/<Link>/<button> elements,
 * or the <Button> component for plain buttons. Keeps every clickable control in
 * the product visually consistent (radius, height, focus, loading, disabled).
 */
export const buttonClasses = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors select-none disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-wait',
  {
    variants: {
      variant: {
        primary:
          'bg-brand-gradient text-white shadow-soft hover:shadow-glow-brand hover:brightness-[1.04] transition-all',
        secondary: 'bg-foreground text-background hover:opacity-90',
        outline: 'border border-border bg-card text-foreground hover:bg-muted hover:border-muted-foreground/30',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        subtle: 'bg-brand-500/10 text-brand-700 hover:bg-brand-500/20 dark:text-brand-300',
        danger: 'bg-red-600 text-white hover:bg-red-700 shadow-soft',
        'danger-outline':
          'border border-red-200 bg-card text-red-700 hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10',
      },
      size: {
        sm: 'h-9 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-sm',
        icon: 'h-10 w-10 p-0',
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
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
