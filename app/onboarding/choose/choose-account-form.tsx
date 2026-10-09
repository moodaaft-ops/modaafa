'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import { inputClasses } from '@/lib/ui/field';
import { Alert } from '@/lib/ui/alert';
import { cn, formatCurrency } from '@/lib/utils';
import { formatGoogleAdsCustomerId, googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { accountStatusView, type AccountStatusTone } from '@/lib/onboarding/account-choice';
import { foldArabicSearch, toAsciiDigits } from '@/lib/accounts/search';

type Account = {
  customer_id: string;
  customer_name: string | null;
  google_status?: string | null;
  currency_code?: string | null;
  spend: number | null;
};

const SEARCH_THRESHOLD = 8;

const squareTone: Record<AccountStatusTone, string> = {
  active: 'bg-signal',
  attention: 'bg-danger',
  stopped: 'bg-muted-foreground',
};

const selectErrors: Record<string, string> = {
  account_not_found: 'هذا الحساب ما عاد مربوطاً. حدّث الصفحة واختر غيره.',
  selection_persistence_failed: 'ما قدرنا نحفظ اختيارك. جرّب مرة ثانية.',
  too_many_requests: 'طلبات كثيرة خلال وقت قصير. انتظر دقيقة ثم جرّب.',
};

export function ChooseAccountForm({
  accounts,
  initialCustomerId,
}: {
  accounts: Account[];
  initialCustomerId: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(
    initialCustomerId && accounts.some((account) => account.customer_id === initialCustomerId)
      ? initialCustomerId
      : null
  );
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = foldArabicSearch(toAsciiDigits(query.trim()));
    if (!needle) return accounts;
    const digits = needle.replace(/\D/g, '');
    return accounts.filter((account) => {
      const name = foldArabicSearch(googleAdsAccountDisplayName(account));
      return name.includes(needle) || (digits.length > 0 && account.customer_id.includes(digits));
    });
  }, [accounts, query]);

  async function submit() {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/accounts/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(selectErrors[body.error ?? ''] ?? 'ما قدرنا نحفظ اختيارك. جرّب مرة ثانية.');
        setSaving(false);
        return;
      }
      router.push('/onboarding/first-audit');
    } catch {
      setError('انقطع الاتصال قبل حفظ اختيارك. جرّب مرة ثانية.');
      setSaving(false);
    }
  }

  return (
    <section className="surface-card p-5 sm:p-6">
      {accounts.length > SEARCH_THRESHOLD && (
        <div className="mb-4">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={inputClasses}
            placeholder="ابحث بالاسم أو رقم الحساب"
            aria-label="ابحث في الحسابات"
          />
        </div>
      )}

      <div role="radiogroup" aria-label="الحسابات الإعلانية" className="max-h-[28rem] space-y-2 overflow-y-auto">
        {visible.map((account) => {
          const status = accountStatusView(account.google_status);
          const checked = selected === account.customer_id;
          return (
            <label
              key={account.customer_id}
              className={cn(
                'flex cursor-pointer items-center gap-3 border px-4 py-3 transition-colors duration-150',
                checked ? 'border-foreground bg-muted' : 'border-border bg-background-elevated hover:border-border-strong'
              )}
            >
              <input
                type="radio"
                name="customer_id"
                value={account.customer_id}
                checked={checked}
                onChange={() => setSelected(account.customer_id)}
                className="h-4 w-4 flex-shrink-0 accent-primary"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-foreground">
                  {googleAdsAccountDisplayName(account)}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('status-square', squareTone[status.tone])} aria-hidden />
                    {status.label}
                  </span>
                  <span className="numeric" dir="ltr">
                    {formatGoogleAdsCustomerId(account.customer_id)}
                  </span>
                </span>
              </span>
              <span className="flex-shrink-0 text-end">
                <span className="block text-[11px] text-muted-foreground">صرف 30 يوم</span>
                <span className="numeric block text-[14px] font-semibold text-foreground">
                  {account.spend === null ? 'غير متاح' : formatCurrency(account.spend, account.currency_code)}
                </span>
              </span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">ما فيه حساب يطابق البحث.</p>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <p className="text-[12.5px] text-muted-foreground">
          {selected ? 'جاهز للمتابعة.' : 'اختر حساباً واحداً للمتابعة.'}
        </p>
        <button
          type="button"
          onClick={submit}
          disabled={!selected || saving}
          aria-busy={saving}
          className={buttonClasses({ variant: 'primary', size: 'lg' })}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? 'جاري الحفظ...' : 'متابعة بهذا الحساب'}
          {!saving && <ArrowLeft className="h-4 w-4" />}
        </button>
      </div>
    </section>
  );
}
