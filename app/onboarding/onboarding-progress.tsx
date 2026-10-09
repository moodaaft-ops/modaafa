import Link from 'next/link';
import { Check, LayoutDashboard } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The real gates between sign-up and a first result, in order. The preparing
 * screen is part of "ربط Google Ads" and the first-audit view is the
 * destination, so neither is its own step.
 */
const steps = [
  { id: 'business', href: '/onboarding/business', label: 'بيانات النشاط', caption: 'دقيقة واحدة' },
  { id: 'connect', href: '/onboarding/connect', label: 'ربط Google Ads', caption: 'موافقة واحدة' },
  { id: 'choose', href: '/onboarding/choose', label: 'اختيار الحساب', caption: 'حسب الصرف' },
  { id: 'first-audit', href: '/onboarding/first-audit', label: 'أول فحص', caption: 'بدون بطاقة' },
] as const;

type StepId = (typeof steps)[number]['id'];

export function OnboardingProgress({
  active,
  /** Shown once the user already has data to go back to. */
  showDashboardLink = false,
}: {
  active: StepId;
  showDashboardLink?: boolean;
}) {
  const activeIndex = steps.findIndex((step) => step.id === active);

  return (
    <div className="surface-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div>
            <div className="text-[13px] font-semibold leading-tight">تجهيز مُضاعِف</div>
            <div className="text-[11px] leading-tight text-muted-foreground">
              الخطوة {activeIndex + 1} من {steps.length}
            </div>
          </div>
        </div>

        {showDashboardLink && (
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            تخطي إلى لوحة التحكم
          </Link>
        )}
      </div>

      <ol className="grid grid-cols-2 sm:grid-cols-4">
        {steps.map((step, index) => {
          const done = index < activeIndex;
          const current = index === activeIndex;

          const body = (
            <>
              <span
                className={cn(
                  'flex h-7 w-7 flex-shrink-0 items-center justify-center border text-xs font-bold transition-colors duration-150',
                  done && 'border-primary bg-primary text-primary-foreground',
                  current && 'border-primary bg-primary/10 text-primary',
                  !done && !current && 'border-border bg-background-elevated text-foreground-subtle'
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'block truncate text-[13px] font-semibold',
                    current ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {step.label}
                </span>
                <span className="block truncate text-[11px] text-foreground-subtle">{step.caption}</span>
              </span>
            </>
          );

          return (
            <li
              key={step.id}
              className={cn(
                'relative border-border',
                index % 2 === 1 && 'border-s',
                index >= 2 && 'border-t sm:border-t-0',
                index === 2 && 'sm:border-s',
                current && 'bg-primary/[0.04]'
              )}
            >
              {/* The active step gets a top rule — the one place in the shell
                  where colour marks position, so it reads at a glance. */}
              {current && <span className="absolute inset-x-0 top-0 h-0.5 bg-signal" aria-hidden />}
              {done ? (
                <Link
                  href={step.href}
                  className="flex items-center gap-2.5 px-4 py-3.5 transition-colors duration-150 hover:bg-muted/60"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-2.5 px-4 py-3.5">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
