'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, LockKeyhole, OctagonX, Save, ShieldCheck } from 'lucide-react';
import type { AutopilotMode, AutopilotSettings } from '@/lib/autopilot/types';
import { Alert } from '@/lib/ui/alert';
import { Button } from '@/lib/ui/button';
import { inputClasses } from '@/lib/ui/field';
import { cn } from '@/lib/utils';

const modes: Array<{
  value: AutopilotMode;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: 'off',
    title: 'متوقف',
    description: 'لا تنفيذ تلقائي؛ تبقى توصيات الفحص المعتادة تحت موافقتك.',
    icon: OctagonX,
  },
  {
    value: 'observe',
    title: 'مراقبة فقط',
    description: 'يحلل ويشرح قراراته، ويرسل التغييرات لمركز الموافقات.',
    icon: Eye,
  },
  {
    value: 'conservative',
    title: 'تنفيذ محافظ',
    description: 'ينفذ فقط الإجراءات الصغيرة المسموحة بعد اجتياز كل قواعد الأمان.',
    icon: ShieldCheck,
  },
];

export function AutopilotSettingsForm({
  account,
  initialSettings,
  subscriptionActive,
  globalExecutionEnabled,
}: {
  account: { customerId: string; name: string };
  initialSettings: AutopilotSettings;
  subscriptionActive: boolean;
  globalExecutionEnabled: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<AutopilotMode>(initialSettings.mode);
  const [dailyLimit, setDailyLimit] = useState(initialSettings.max_daily_changes);
  const [confidence, setConfidence] = useState(Math.round(initialSettings.min_confidence * 100));
  const [cooldown, setCooldown] = useState(initialSettings.cooldown_hours);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  async function save(nextMode = mode) {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/autopilot/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: account.customerId,
          mode: nextMode,
          max_daily_changes: dailyLimit,
          min_confidence: confidence / 100,
          cooldown_hours: cooldown,
          require_healthy_tracking: true,
          anomaly_pause_enabled: true,
          confirm_conservative: nextMode === 'conservative' ? confirmed : true,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? 'تعذر حفظ الإعدادات.');

      setMode(nextMode);
      setConfirmed(false);
      setMessage({
        tone: 'success',
        text:
          nextMode === 'off'
            ? 'تم إيقاف الطيار الآلي فوراً لهذا الحساب.'
            : 'تم حفظ الإعدادات، وستظهر كل القرارات في السجل أدناه.',
      });
      router.refresh();
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'تعذر حفظ الإعدادات.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {!globalExecutionEnabled && mode === 'conservative' && (
        <Alert tone="warning" title="التنفيذ العام مقفل حالياً">
          سيستمر الحساب في المراقبة وتسجيل القرارات، لكن لن يرسل أي تعديل تلقائي إلى Google Ads حتى يفعّل فريق
          مُضاعِف مفتاح الإطلاق بعد التحقق التشغيلي.
        </Alert>
      )}

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <div className="grid gap-3 lg:grid-cols-3" role="radiogroup" aria-label="وضع الطيار الآلي">
        {modes.map((item) => {
          const Icon = item.icon;
          const disabled = item.value === 'conservative' && !subscriptionActive;
          const active = mode === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => setMode(item.value)}
              className={cn(
                'min-h-[126px] rounded-lg border p-4 text-start transition-colors',
                active ? 'border-primary bg-primary/[0.08] ring-1 ring-primary/25' : 'border-border bg-card hover:bg-muted/50',
                disabled && 'cursor-not-allowed opacity-50'
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Icon className="h-4 w-4" aria-hidden />
                {item.title}
              </span>
              <span className="mt-2 block text-xs leading-6 text-muted-foreground">{item.description}</span>
              {disabled && <span className="mt-2 block text-[11px] font-medium text-amber-600">يحتاج اشتراكاً نشطاً</span>}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 rounded-lg border border-border bg-muted/25 p-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-2 block text-xs font-semibold text-foreground">أقصى تغييرات يومية</span>
          <input
            type="number"
            min={1}
            max={3}
            value={dailyLimit}
            onChange={(event) => setDailyLimit(Number(event.target.value))}
            className={inputClasses}
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-xs font-semibold text-foreground">الحد الأدنى للثقة</span>
          <div className="relative">
            <input
              type="number"
              min={95}
              max={100}
              value={confidence}
              onChange={(event) => setConfidence(Number(event.target.value))}
              className={cn(inputClasses, 'pe-9')}
            />
            <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
          </div>
        </label>
        <label className="block">
          <span className="mb-2 block text-xs font-semibold text-foreground">انتظار تكرار الهدف</span>
          <div className="relative">
            <input
              type="number"
              min={24}
              max={168}
              value={cooldown}
              onChange={(event) => setCooldown(Number(event.target.value))}
              className={cn(inputClasses, 'pe-14')}
            />
            <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">ساعة</span>
          </div>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SafetyLock
          title="سلامة تتبع التحويلات إلزامية"
          description="لا ينفذ الطيار الآلي عند الشك في دقة القياس."
        />
        <SafetyLock
          title="التوقف عند الحالات غير الطبيعية إلزامي"
          description="أي شذوذ في البيانات يحول القرار إلى مراجعة بشرية."
        />
      </div>

      {mode === 'conservative' && (
        <label className="flex cursor-pointer gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-4">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
          />
          <span className="text-xs leading-6 text-foreground">
            أفهم أن الإصدار الأول ينفذ تلقائياً فقط إضافة كلمة سلبية <strong>مطابقة تامة</strong> عندما تثبت البيانات
            أنها غير مرتبطة، ولا يغيّر الميزانيات أو عروض الأسعار أو يوقف الحملات تلقائياً.
          </span>
        </label>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          onClick={() => save()}
          loading={saving}
          loadingLabel="جاري الحفظ..."
          disabled={mode === 'conservative' && !confirmed}
        >
          <Save className="h-4 w-4" />
          حفظ إعدادات {account.name}
        </Button>
        {initialSettings.mode !== 'off' && (
          <Button type="button" variant="danger-outline" onClick={() => save('off')} disabled={saving}>
            <OctagonX className="h-4 w-4" />
            إيقاف فوري
          </Button>
        )}
      </div>
    </div>
  );
}

function SafetyLock({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
      <span>
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <LockKeyhole className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" aria-hidden />
    </div>
  );
}
