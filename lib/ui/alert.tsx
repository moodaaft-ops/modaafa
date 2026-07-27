import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const toneStyles: Record<Tone, { box: string; icon: string; Icon: React.ComponentType<{ className?: string }> }> = {
  info: {
    box: 'border-blue-500/25 bg-blue-500/[0.08] text-blue-900 dark:text-blue-100',
    icon: 'text-blue-500',
    Icon: Info,
  },
  success: {
    box: 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-900 dark:text-emerald-100',
    icon: 'text-emerald-500',
    Icon: CheckCircle2,
  },
  warning: {
    box: 'border-amber-500/25 bg-amber-500/[0.08] text-amber-900 dark:text-amber-100',
    icon: 'text-amber-500',
    Icon: AlertTriangle,
  },
  danger: {
    box: 'border-red-500/25 bg-red-500/[0.08] text-red-900 dark:text-red-100',
    icon: 'text-red-500',
    Icon: XCircle,
  },
};

/** Consistent inline notice (error / success / warning / info). */
export function Alert({
  tone = 'info',
  title,
  children,
  icon = true,
  className,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  icon?: boolean;
  className?: string;
}) {
  const styles = toneStyles[tone];
  const Icon = styles.Icon;
  return (
    <div
      className={cn(
        'flex animate-fade-in-fast gap-3 rounded-lg border px-4 py-3 text-sm leading-6',
        styles.box,
        className
      )}
      role="status"
    >
      {icon && <Icon className={cn('mt-0.5 h-5 w-5 flex-shrink-0', styles.icon)} aria-hidden />}
      <div className="min-w-0 leading-6">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-1 opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}
