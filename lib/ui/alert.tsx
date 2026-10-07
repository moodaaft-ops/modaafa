import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const toneStyles: Record<Tone, { box: string; icon: string; Icon: React.ComponentType<{ className?: string }> }> = {
  info: {
    box: 'border-info/25 bg-info/[0.08] text-info dark:text-info',
    icon: 'text-info',
    Icon: Info,
  },
  success: {
    box: 'border-success/25 bg-success/[0.08] text-success dark:text-success',
    icon: 'text-success',
    Icon: CheckCircle2,
  },
  warning: {
    box: 'border-warning/25 bg-warning/[0.08] text-warning dark:text-warning',
    icon: 'text-warning',
    Icon: AlertTriangle,
  },
  danger: {
    box: 'border-danger/25 bg-danger/[0.08] text-danger dark:text-danger',
    icon: 'text-danger',
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
      // Errors and warnings are announced assertively; success/info politely.
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
    >
      {icon && <Icon className={cn('mt-0.5 h-5 w-5 flex-shrink-0', styles.icon)} aria-hidden />}
      <div className="min-w-0 leading-6">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-1 opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}
