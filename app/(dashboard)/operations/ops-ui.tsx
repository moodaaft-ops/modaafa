import Link from 'next/link';
import { ArrowDownLeft, ArrowUpLeft, Mail, MessageCircle, Minus } from 'lucide-react';
import { cn, formatNumberAr } from '@/lib/utils';
import { STAGES, STAGE_LABELS, type AccessState, type CustomerStage } from '@/lib/platform/operator-insights';
import { contactHref } from '@/lib/platform/operator-page';

/**
 * Shared pieces of the operations center. Server components only; the one
 * interactive part (operator actions) lives in its own client file.
 */

export function OpsTabs({ active, updatedAt }: { active: 'overview' | 'customers' | 'costs' | 'signals'; updatedAt: string }) {
  const tabs = [
    { key: 'overview', href: '/operations', label: 'نظرة عامة' },
    { key: 'customers', href: '/operations/users', label: 'العملاء' },
    { key: 'costs', href: '/operations/costs', label: 'التكلفة' },
    { key: 'signals', href: '/operations/onboarding-signals', label: 'قراءة الحساب' },
  ] as const;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 sm:px-6 lg:px-8">
      <nav className="-mb-px flex gap-1" aria-label="أقسام مركز التشغيل">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active === tab.key ? 'page' : undefined}
            className={cn(
              'border-b-2 px-2.5 pb-2.5 pt-1 text-sm font-semibold transition-colors sm:px-3',
              active === tab.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <p className="pb-2.5 text-xs text-muted-foreground">
        الأرقام وقت فتح الصفحة · <span className="numeric">{updatedAt}</span>
      </p>
    </div>
  );
}

export function SectionHead({
  title,
  note,
  aside,
  id,
}: {
  title: string;
  note?: React.ReactNode;
  aside?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <h2 id={id} className="text-base font-bold text-foreground">
          {title}
        </h2>
        {note && <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{note}</p>}
      </div>
      {aside}
    </div>
  );
}

/** This week against last week, with a plain-language hint. */
export function Delta({ current, previous, inverse = false }: { current: number; previous: number; inverse?: boolean }) {
  const diff = current - previous;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs opacity-70">
        <Minus className="h-3 w-3" aria-hidden />
        نفس الأسبوع اللي قبل
      </span>
    );
  }
  const up = diff > 0;
  const good = inverse ? !up : up;
  const Icon = up ? ArrowUpLeft : ArrowDownLeft;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', good ? 'text-success' : 'text-danger')}>
      <Icon className="h-3 w-3" aria-hidden />
      <bdi dir="ltr" className="numeric">
        {up ? '+' : '−'}
        {formatNumberAr(Math.abs(diff))}
      </bdi>
      <span className="font-normal opacity-80">عن الأسبوع اللي قبل</span>
    </span>
  );
}

const ACCESS_TONE: Record<AccessState, string> = {
  active: 'text-success ring-success/30 bg-success/10',
  trialing: 'text-foreground ring-border-strong bg-signal/25',
  past_due: 'text-danger ring-danger/30 bg-danger/10',
  canceled: 'text-muted-foreground ring-border bg-muted',
  trial_ended: 'text-muted-foreground ring-border bg-muted',
  comp: 'text-foreground ring-foreground/30 bg-background',
  suspended: 'text-background ring-danger bg-danger',
  none: 'text-muted-foreground ring-border bg-transparent',
};

export function AccessChip({ access, label }: { access: AccessState; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap px-2 py-0.5 text-[11px] font-semibold leading-5 ring-1 ring-inset',
        ACCESS_TONE[access]
      )}
    >
      {label}
    </span>
  );
}

/** Seven squares, filled up to the furthest stage. The brand's own geometry as a progress mark. */
export function StageTrack({ milestones, stage }: { milestones: Record<CustomerStage, boolean>; stage: CustomerStage }) {
  return (
    <span className="inline-flex items-center gap-2" title={STAGE_LABELS[stage]}>
      <span className="inline-flex gap-[3px]" aria-hidden>
        {STAGES.map((key) => (
          <span
            key={key}
            className={cn(
              'h-2 w-2',
              milestones[key] ? (key === stage ? 'bg-signal ring-1 ring-foreground/40' : 'bg-foreground') : 'bg-border'
            )}
          />
        ))}
      </span>
      <span className="text-xs text-foreground">{STAGE_LABELS[stage]}</span>
    </span>
  );
}

export function ContactButton({
  profile,
  text,
  compact = false,
}: {
  profile: { phone: string | null; email: string };
  text: string;
  compact?: boolean;
}) {
  const contact = contactHref(profile, text);
  if (!contact) return null;
  const Icon = contact.kind === 'whatsapp' ? MessageCircle : Mail;
  return (
    <a
      href={contact.href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 border border-border-strong px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-foreground hover:bg-surface',
        compact && 'px-2'
      )}
      title={contact.kind === 'whatsapp' ? 'واتساب برسالة جاهزة' : 'إيميل برسالة جاهزة (ما عنده رقم)'}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {!compact && (contact.kind === 'whatsapp' ? 'واتساب' : 'إيميل')}
    </a>
  );
}

export function MigrationNotice({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <div className="border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-6 text-foreground">
      <span className="font-semibold">ميقريشن مركز التشغيل ما انشغل بعد.</span> الأرقام كلها سليمة، بس الخطط المجانية
      والإيقاف وسجل الإجراءات ما تشتغل لين ينشغل{' '}
      <code className="break-all font-mono text-xs" dir="ltr">
        db/migrations/20261012_operator_console.sql
      </code>{' '}
      على Supabase.
    </div>
  );
}

/** Shown when a table hit the read cap: counts drawn from it are a floor, not exact. */
export function TruncatedNotice({ tables }: { tables?: string[] }) {
  if (!tables || tables.length === 0) return null;
  return (
    <p className="border border-border-strong px-4 py-2.5 text-[13px] text-muted-foreground">
      بعض الجداول أكبر من حد القراءة (<span dir="ltr" className="font-mono text-xs">{tables.join(', ')}</span>)، فالأرقام
      المبنية عليها أقل من الحقيقة. وقتها ننقل الحساب لقاعدة البيانات.
    </p>
  );
}
