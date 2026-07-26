import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const steps = [
  { id: 'business', href: '/onboarding/business', label: 'بيانات النشاط' },
  { id: 'connect', href: '/onboarding/connect', label: 'ربط الحسابات' },
  { id: 'accounts', href: '/dashboard', label: 'اختيار الحساب' },
  { id: 'audit', href: '/audit', label: 'أول فحص' },
] as const;

type StepId = (typeof steps)[number]['id'];

export function OnboardingProgress({ active }: { active: StepId }) {
  const activeIndex = steps.findIndex((step) => step.id === active);

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-soft sm:p-5">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="text-xs font-semibold text-brand-700 dark:text-brand-300">تجهيز مُضاعِف</div>
          <h1 className="mt-1 text-lg font-bold sm:text-xl">خطوات الإعداد</h1>
        </div>
        <span className="whitespace-nowrap text-sm font-medium text-muted-foreground">
          الخطوة {activeIndex + 1} من {steps.length}
        </span>
      </div>

      <ol className="flex items-center">
        {steps.map((step, index) => {
          const done = index < activeIndex;
          const current = index === activeIndex;
          const isLast = index === steps.length - 1;

          const circle = (
            <span
              className={cn(
                'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border text-sm font-bold transition',
                done && 'border-brand-600 bg-brand-600 text-white',
                current && 'border-brand-600 bg-brand-50 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300 ring-4 ring-brand-100 dark:ring-brand-500/25',
                !done && !current && 'border-border bg-card text-muted-foreground'
              )}
            >
              {done ? <Check className="h-4 w-4" /> : index + 1}
            </span>
          );

          const label = (
            <span
              className={cn(
                'hidden text-sm font-medium sm:block',
                current ? 'text-foreground' : done ? 'text-muted-foreground' : 'text-muted-foreground'
              )}
            >
              {step.label}
            </span>
          );

          return (
            <li key={step.id} className={cn('flex items-center', !isLast && 'flex-1')}>
              {done ? (
                <Link href={step.href} className="flex items-center gap-2 rounded-lg p-1 hover:bg-muted">
                  {circle}
                  {label}
                </Link>
              ) : (
                <div className="flex items-center gap-2 p-1">
                  {circle}
                  {label}
                </div>
              )}
              {!isLast && (
                <span className="mx-2 h-0.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className={cn('block h-full rounded-full bg-brand-500 transition-all', done ? 'w-full' : 'w-0')} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
