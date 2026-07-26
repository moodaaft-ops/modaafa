import { CreditCard, Sparkles } from 'lucide-react';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';

export function SubscriptionGate({
  title = 'ابدأ التجربة لتفعيل هذه الخاصية',
  description = 'ربط الحسابات والتبديل بينها يبقى متاحاً. الاشتراك يفعّل المساعد والفحص والعمليات التي تستهلك موارد المنصة.',
  compact = false,
}: {
  title?: string;
  description?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Alert tone="warning">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{description}</span>
          <a href="/billing" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            عرض الخطط
          </a>
        </div>
      </Alert>
    );
  }

  return (
    <section className="mx-auto max-w-2xl surface-card p-8 text-center shadow-card">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary">
        <Sparkles className="h-7 w-7" />
      </span>
      <h2 className="mt-5 text-2xl font-bold text-foreground">{title}</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-muted-foreground">{description}</p>
      <a href="/billing" className={buttonClasses({ variant: 'primary', size: 'lg', className: 'mt-6' })}>
        <CreditCard className="h-4 w-4" />
        عرض الخطط وبدء التجربة
      </a>
    </section>
  );
}
