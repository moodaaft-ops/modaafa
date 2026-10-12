'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

type Props = {
  userId: string;
  trialEndsAt: string | null;
  hasStripeTrial: boolean;
  grant: { plan: string; expiresAt: string | null } | null;
  suspended: boolean;
  targetIsOperator: boolean;
  migrationMissing: boolean;
  hasPaidPlan: boolean;
};

type Action = 'extend_trial' | 'grant_plan' | 'revoke_plan' | 'suspend' | 'unsuspend';

const PLAN_OPTIONS = [
  { value: 'starter', label: 'البداية' },
  { value: 'growth', label: 'النمو' },
  { value: 'pro', label: 'الاحتراف' },
];

const dateLabel = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date(iso)
      )
    : null;

/**
 * The operator's controls on a customer page. Every action needs a reason and
 * a ticked confirmation, and the server writes it to the audit log before it
 * does anything (lib/platform/operator-actions.ts).
 */
export function OperatorActions(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  async function run(action: Action, fields: Record<string, unknown>) {
    setMessage(null);
    const res = await fetch(`/api/operations/users/${props.userId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, confirm: true, ...fields }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      setMessage({ tone: 'danger', text: json.message ?? 'صار خطأ وما تم الإجراء.' });
      return;
    }
    const done: Record<Action, string> = {
      extend_trial: `تمددت التجربة لين ${dateLabel(json.result?.trial_end ?? null) ?? 'الموعد الجديد'}.`,
      grant_plan: 'انعطى الخطة المجانية، وتشتغل من الحين.',
      revoke_plan: 'انسحبت الخطة المجانية.',
      suspend: 'انوقف الحساب. التحديث والمحسّن والتنفيذ والمساعد واقفين له.',
      unsuspend: 'رجع الحساب يشتغل.',
    };
    setMessage({ tone: 'success', text: done[action] });
    setOpen(null);
    startTransition(() => router.refresh());
  }

  const disabledAll = props.migrationMissing;

  return (
    <div className="space-y-2">
      {message && (
        <p
          role="status"
          className={cn(
            'px-3 py-2 text-[13px] leading-6',
            message.tone === 'success' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
          )}
        >
          {message.text}
        </p>
      )}
      {disabledAll && (
        <p className="bg-warning/10 px-3 py-2 text-[13px] leading-6 text-foreground">
          الأدوات كلها تنتظر ميقريشن مركز التشغيل على Supabase، لأن كل إجراء ينكتب في سجل التدقيق قبل ما ينفذ.
        </p>
      )}

      <ActionBlock
        title="مدّد التجربة"
        hint={
          props.hasStripeTrial
            ? `تنتهي ${dateLabel(props.trialEndsAt) ?? 'قريب'}. التمديد يتحسب من نهايتها، والخصم الأول يتأخر معها في Stripe.`
            : 'ما عنده تجربة شغالة في Stripe. لو تبي تعطيه وقت مجاني استخدم الخطة المجانية.'
        }
        disabled={!props.hasStripeTrial || disabledAll}
        open={open === 'extend_trial'}
        onToggle={() => setOpen(open === 'extend_trial' ? null : 'extend_trial')}
      >
        <ActionForm
          busy={pending}
          submitLabel="مدّد"
          onSubmit={(form) => run('extend_trial', { days: Number(form.get('days')), reason: form.get('reason') })}
        >
          <label className="block text-xs font-semibold text-foreground">
            كم يوم
            <select name="days" defaultValue="7" className="mt-1 block h-10 w-full border border-border-strong bg-background px-2 text-base sm:text-sm">
              {[3, 7, 14, 30].map((days) => (
                <option key={days} value={days}>
                  {days} أيام
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
      </ActionBlock>

      <ActionBlock
        title={props.grant ? 'غيّر الخطة المجانية' : 'أعطه خطة مجانية'}
        hint={
          props.grant
            ? `عنده الحين خطة ${PLAN_OPTIONS.find((p) => p.value === props.grant!.plan)?.label ?? props.grant.plan} مجانية ${
                props.grant.expiresAt ? `لين ${dateLabel(props.grant.expiresAt)}` : 'بدون نهاية'
              }.`
            : `يشتغل له كل شي بدون Stripe.${props.hasPaidPlan ? ' عنده اشتراك مدفوع، والمجانية تطلع بس لو أعلى منه، والفوترة ما تتأثر.' : ''}${
                props.hasStripeTrial ? ' تجربته في Stripe ما تنلغي وبيتخصم عند نهايتها لو ما ألغاها.' : ''
              }`
        }
        disabled={disabledAll}
        open={open === 'grant_plan'}
        onToggle={() => setOpen(open === 'grant_plan' ? null : 'grant_plan')}
      >
        <ActionForm
          busy={pending}
          submitLabel="أعطه الخطة"
          onSubmit={(form) =>
            run('grant_plan', { plan: form.get('plan'), expiresAt: form.get('expiresAt') || null, reason: form.get('reason') })
          }
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-semibold text-foreground">
              الخطة
              <select name="plan" defaultValue={props.grant?.plan ?? 'growth'} className="mt-1 block h-10 w-full border border-border-strong bg-background px-2 text-base sm:text-sm">
                {PLAN_OPTIONS.map((plan) => (
                  <option key={plan.value} value={plan.value}>
                    {plan.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold text-foreground">
              لين (اختياري)
              <input type="date" name="expiresAt" className="mt-1 block h-10 w-full border border-border-strong bg-background px-2 text-base sm:text-sm" />
            </label>
          </div>
        </ActionForm>
      </ActionBlock>

      {props.grant && (
        <ActionBlock
          title="اسحب الخطة المجانية"
          hint="يرجع لوضعه في Stripe، ولو ما عنده اشتراك تنقفل عليه الميزات المدفوعة."
          disabled={disabledAll}
          open={open === 'revoke_plan'}
          onToggle={() => setOpen(open === 'revoke_plan' ? null : 'revoke_plan')}
        >
          <ActionForm busy={pending} submitLabel="اسحبها" onSubmit={(form) => run('revoke_plan', { reason: form.get('reason') })} />
        </ActionBlock>
      )}

      {props.suspended ? (
        <ActionBlock
          title="رجّع الحساب"
          hint="يرجع التحديث والمحسّن والتنفيذ والمساعد مثل قبل."
          disabled={disabledAll}
          open={open === 'unsuspend'}
          onToggle={() => setOpen(open === 'unsuspend' ? null : 'unsuspend')}
        >
          <ActionForm busy={pending} submitLabel="رجّعه" onSubmit={(form) => run('unsuspend', { reason: form.get('reason') })} />
        </ActionBlock>
      ) : (
        <ActionBlock
          title="أوقف الحساب"
          danger
          hint={
            props.targetIsOperator
              ? 'هذا حساب مشغّل وما ينوقف.'
              : 'يوقف التحديث والمحسّن والتنفيذ والمساعد والفحوصات، ويطلع له شريط إن حسابه موقوف. الفوترة في Stripe ما تتوقف.'
          }
          disabled={props.targetIsOperator || disabledAll}
          open={open === 'suspend'}
          onToggle={() => setOpen(open === 'suspend' ? null : 'suspend')}
        >
          <ActionForm busy={pending} danger submitLabel="أوقفه" onSubmit={(form) => run('suspend', { reason: form.get('reason') })} />
        </ActionBlock>
      )}
    </div>
  );
}

function ActionBlock({
  title,
  hint,
  disabled,
  danger,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  disabled?: boolean;
  danger?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('border', open ? 'border-foreground' : 'border-border', disabled && 'opacity-60')}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-start disabled:cursor-not-allowed"
      >
        <span>
          <span className={cn('block text-sm font-semibold', danger ? 'text-danger' : 'text-foreground')}>{title}</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{hint}</span>
        </span>
        <span className="mt-0.5 text-lg leading-none text-muted-foreground" aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && !disabled && <div className="border-t border-border px-3 py-3">{children}</div>}
    </div>
  );
}

function ActionForm({
  children,
  submitLabel,
  onSubmit,
  busy,
  danger,
}: {
  children?: React.ReactNode;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<void> | void;
  busy: boolean;
  danger?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!confirmed || sending) return;
        setSending(true);
        try {
          await onSubmit(new FormData(event.currentTarget));
        } finally {
          setSending(false);
        }
      }}
    >
      {children}
      <label className="block text-xs font-semibold text-foreground">
        السبب (ينحفظ في سجل التدقيق)
        <textarea
          name="reason"
          required
          minLength={3}
          maxLength={500}
          rows={2}
          placeholder="مثال: طلب على الواتساب، تعويض عن عطل المحسّن"
          className="mt-1 block w-full resize-y border border-border-strong bg-background px-2 py-1.5 text-base font-normal sm:text-sm"
        />
      </label>
      <label className="flex items-start gap-2 text-xs text-foreground">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4" />
        متأكد، نفّذ على هذا العميل
      </label>
      <button
        type="submit"
        disabled={!confirmed || sending || busy}
        className={cn(
          'h-10 w-full text-sm font-semibold disabled:opacity-40',
          danger ? 'bg-danger text-background' : 'bg-foreground text-background'
        )}
      >
        {sending ? 'ينفذ…' : submitLabel}
      </button>
    </form>
  );
}
