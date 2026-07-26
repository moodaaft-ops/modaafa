import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const toneStyles: Record<Tone, { box: string; icon: string; Icon: React.ComponentType<{ className?: string }> }> = {
  info: {
    box: 'border-blue-100 bg-blue-50 text-blue-800 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-blue-200',
    icon: 'text-blue-500',
    Icon: Info,
  },
  success: {
    box: 'border-emerald-100 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200',
    icon: 'text-emerald-500',
    Icon: CheckCircle2,
  },
  warning: {
    box: 'border-amber-100 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200',
    icon: 'text-amber-500',
    Icon: AlertTriangle,
  },
  danger: {
    box: 'border-red-100 bg-red-50 text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200',
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
    <div className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', styles.box, className)} role="status">
      {icon && <Icon className={cn('mt-0.5 h-5 w-5 flex-shrink-0', styles.icon)} aria-hidden />}
      <div className="min-w-0 leading-6">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-1 opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}
