'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  Building2,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  CircleAlert,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import { searchGoogleAdsAccounts } from '@/lib/accounts/search';
import {
  formatGoogleAdsCustomerId,
  googleAdsAccountDisplayName,
  googleAdsAccountNameMissing,
} from '@/lib/accounts/display';
import { StatusBadge } from '@/lib/ui/status-badge';
import { cn, formatDateShortAr } from '@/lib/utils';

export function AccountSwitcher({
  accounts,
  revokedAccounts,
  selectedCustomerId,
}: {
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  selectedCustomerId: string | null;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(selectedCustomerId ?? '');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncedJustNow, setSyncedJustNow] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [repairingNames, setRepairingNames] = useState(false);
  const [nameRepairMessage, setNameRepairMessage] = useState('');
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [billingRequired, setBillingRequired] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setValue(selectedCustomerId ?? '');
    setSelecting(false);
  }, [selectedCustomerId]);

  const selected = accounts.find((account) => account.customer_id === value);
  const hasMissingNames = accounts.some((account) => googleAdsAccountNameMissing(account));
  const missingCount = accounts.filter((account) => googleAdsAccountNameMissing(account)).length;
  const missingNameKey = useMemo(
    () =>
      accounts
        .filter((account) => googleAdsAccountNameMissing(account))
        .map((account) => account.customer_id)
        .sort()
        .join(','),
    [accounts]
  );
  const filteredAccounts = useMemo(() => {
    return searchGoogleAdsAccounts(accounts, query);
  }, [accounts, query]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function handlePointer(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) closeMenu();
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu();
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open, closeMenu]);

  // Auto-repair account names Google didn't return (guarded so it runs once per set).
  useEffect(() => {
    if (!hasMissingNames || !missingNameKey) return;

    const storageKey = `mudaaf-gads-name-repair:v2:${missingNameKey}`;
    if (window.sessionStorage.getItem(storageKey)) return;
    window.sessionStorage.setItem(storageKey, '1');

    let cancelled = false;
    setRepairingNames(true);
    setNameRepairMessage('');
    setReconnectRequired(false);

    fetch('/api/accounts/repair-names', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(payload.error ?? 'repair_failed'));
        if (cancelled) return;

        if (payload.reconnectRequired) {
          setReconnectRequired(true);
          setNameRepairMessage('انتهت صلاحية ربط Google Ads القديم. أعد الربط لتحديث الأسماء والبيانات.');
          return;
        }

        if (Number(payload.updated ?? 0) > 0) {
          const unresolved = Number(payload.unresolved ?? 0);
          setNameRepairMessage(
            unresolved > 0
              ? `تم تحديث ${payload.updated} اسم، وبقي ${unresolved} حساب لا ترجع Google اسمه تلقائياً`
              : `تم تحديث ${payload.updated} اسم من Google`
          );
          startTransition(() => router.refresh());
        } else {
          setNameRepairMessage('راجعنا Google؛ الحسابات المتبقية لا ترجع أسماءها تلقائياً ويمكن تسميتها من الإعدادات');
        }
      })
      .catch(() => {
        if (!cancelled) setNameRepairMessage('تعذر تحديث أسماء الحسابات تلقائياً الآن');
      })
      .finally(() => {
        if (!cancelled) setRepairingNames(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasMissingNames, missingNameKey, router]);

  async function selectAccount(customerId: string) {
    if (customerId === value) {
      closeMenu();
      return;
    }

    const previousValue = value;
    setValue(customerId);
    closeMenu();
    setError('');
    setBillingRequired(false);
    setSyncedJustNow(false);
    setSelecting(true);

    try {
      const response = await fetch('/api/accounts/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId }),
      });

      if (!response.ok) throw new Error('account_switch_failed');
      startTransition(() => router.refresh());
    } catch {
      setValue(previousValue);
      setSelecting(false);
      setError('تعذر تبديل الحساب. حاول مرة أخرى.');
    }
  }

  async function repairNamesManually() {
    if (repairingNames) return;
    setRepairingNames(true);
    setNameRepairMessage('');
    setReconnectRequired(false);
    try {
      const response = await fetch('/api/accounts/repair-names', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error ?? 'repair_failed'));
      if (payload.reconnectRequired) {
        setReconnectRequired(true);
        setNameRepairMessage('انتهت صلاحية ربط Google Ads القديم. أعد الربط لتحديث الأسماء والبيانات.');
        return;
      }
      if (Number(payload.updated ?? 0) > 0) {
        setNameRepairMessage(`تم تحديث ${payload.updated} اسم من Google`);
        startTransition(() => router.refresh());
      } else {
        setNameRepairMessage('الحسابات المتبقية لا ترجع أسماءها من Google. سمّها يدوياً من الإعدادات.');
      }
    } catch {
      setNameRepairMessage('تعذر تحديث الأسماء الآن. حاول لاحقاً أو سمّها يدوياً من الإعدادات.');
    } finally {
      setRepairingNames(false);
    }
  }

  async function syncAccount() {
    if (!value) return;

    setSyncing(true);
    setError('');
    setBillingRequired(false);
    setSyncedJustNow(false);

    try {
      const response = await fetch('/api/accounts/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: value }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const errorMessage = [payload.code, ...(payload.codes ?? []), payload.message, payload.error].join(' ');
        if (/unauthorized_client|invalid_client|invalid_grant|authentication_error/i.test(errorMessage)) setReconnectRequired(true);
        if (/subscription_required|quota_exceeded/i.test(errorMessage)) setBillingRequired(true);
        setError(friendlySyncError(errorMessage));
        return;
      }

      setSyncedJustNow(true);
      window.setTimeout(() => setSyncedJustNow(false), 5000);
      startTransition(() => router.refresh());
    } catch {
      setError('تعذر الوصول إلى الخادم الآن. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setSyncing(false);
    }
  }

  const busy = isPending || syncing || selecting || repairingNames;
  const revokedAccount = revokedAccounts[0] ?? null;
  const revokedAccountLabel = revokedAccount
    ? `${googleAdsAccountDisplayName(revokedAccount)} (${formatGoogleAdsCustomerId(revokedAccount.customer_id)})`
    : '';

  if (accounts.length === 0) {
    return (
      <div className="mx-4 mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/25 dark:bg-amber-500/15">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
          <CircleAlert className="h-4 w-4" />
          {revokedAccount ? 'انتهت صلاحية ربط Google Ads' : 'لا يوجد حساب إعلاني'}
        </div>
        <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-300">
          {revokedAccount
            ? `انتهت صلاحية الربط لحساب ${revokedAccountLabel}${
                revokedAccounts.length > 1 ? ` و${revokedAccounts.length - 1} حساب آخر` : ''
              }. أعد الربط لاستعادة البيانات.`
            : 'اربط إعلانات Google حتى تظهر بيانات الأداء والتوصيات.'}
        </p>
        <Link
          href="/onboarding/connect"
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/12 px-3 py-2 text-[11.5px] font-semibold text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
        >
          {revokedAccount ? <RefreshCw className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {revokedAccount ? 'إعادة ربط Google Ads' : 'ربط حساب'}
        </Link>
      </div>
    );
  }

  const selectedMissingName = selected ? googleAdsAccountNameMissing(selected) : false;

  return (
    <section ref={containerRef} className="relative mx-4 mt-4 rounded-lg border border-border bg-muted p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase text-muted-foreground">الحساب الإعلاني</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {busy ? (
            <RefreshCw className="h-3 w-3 animate-spin text-primary" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          )}
          {accounts.length} حساب
        </span>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 surface-card px-2.5 py-2 text-start transition hover:border-primary/50"
        >
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
            <Building2 className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">
              {selected ? googleAdsAccountDisplayName(selected) : 'اختر حساباً'}
            </span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground" dir="ltr">
              {formatGoogleAdsCustomerId(selected?.customer_id ?? value)}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full z-50 mt-2 surface-card p-2 shadow-pop">
          <label className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-2">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ابحث بالاسم أو الرقم"
              className="min-w-0 flex-1 rounded bg-transparent text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
              aria-label="ابحث عن حساب"
            />
          </label>

          <div className="mt-2 max-h-72 space-y-1 overflow-y-auto scrollbar-thin" role="listbox">
            {filteredAccounts.map((account) => {
              const active = account.customer_id === value;
              const missing = googleAdsAccountNameMissing(account);
              return (
                <button
                  key={account.customer_id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => selectAccount(account.customer_id)}
                  disabled={selecting}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-start transition disabled:cursor-wait disabled:opacity-70',
                    active ? 'bg-primary/10' : 'hover:bg-muted'
                  )}
                >
                  <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    {active && <Check className="h-4 w-4 text-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-xs font-semibold', active ? 'text-primary' : 'text-foreground')}>
                      {googleAdsAccountDisplayName(account)}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground" dir="ltr">
                      {formatGoogleAdsCustomerId(account.customer_id)}
                    </span>
                    {missing && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        <CircleAlert className="h-3 w-3" />
                        Google لم ترجع اسماً — سمّه من الإعدادات
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {filteredAccounts.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">لا توجد نتيجة مطابقة</div>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
            <Link href="/onboarding/connect" className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-primary hover:bg-primary/10">
              <Plus className="h-3.5 w-3.5" />
              إضافة حساب
            </Link>
            {hasMissingNames && (
              <button
                type="button"
                onClick={repairNamesManually}
                disabled={repairingNames}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/15 disabled:opacity-60"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', repairingNames && 'animate-spin')} />
                جلب أسماء {missingCount} حساب
              </button>
            )}
          </div>
          </div>
        )}
      </div>

      {revokedAccount && (
        <div className="mt-3 rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              انتهت صلاحية ربط Google Ads لحساب {revokedAccountLabel}
              {revokedAccounts.length > 1
                ? ` و${revokedAccounts.length - 1} حساب آخر`
                : ''}
              .
            </span>
          </div>
          <Link
            href="/onboarding/connect"
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 font-semibold text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            إعادة الربط
          </Link>
        </div>
      )}

      {selectedMissingName && !open && (
        <div className="mt-2">
          <StatusBadge tone="warning" icon={CircleAlert}>
            بدون اسم من Google
          </StatusBadge>
        </div>
      )}

      {(repairingNames || nameRepairMessage) && !open && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-100 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/15 px-2 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-300">
          {repairingNames && <RefreshCw className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 animate-spin" />}
          <span>{repairingNames ? 'جاري تحديث أسماء الحسابات من Google...' : nameRepairMessage}</span>
        </div>
      )}

      <button
        type="button"
        onClick={syncAccount}
        disabled={!value || syncing}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 surface-card px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
        {syncing ? 'جاري تحديث البيانات...' : 'تحديث بيانات الحساب'}
      </button>

      <div className="mt-2 min-h-[1rem] text-[11px] leading-5">
        {syncedJustNow ? (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            تم تحديث البيانات الآن
          </span>
        ) : selected?.last_synced_at ? (
          <span className="text-muted-foreground">
            آخر تحديث: {formatDateShortAr(selected.last_synced_at)}
          </span>
        ) : (
          <span className="text-muted-foreground">الاختيار يطبّق على كل الصفحات</span>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-100 dark:border-red-500/25 bg-red-50 dark:bg-red-500/15 px-2 py-2 text-[11px] leading-5 text-red-700 dark:text-red-300">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {reconnectRequired && (
        <Link
          href="/onboarding/connect"
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[11.5px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          إعادة ربط Google Ads
        </Link>
      )}
      {billingRequired && (
        <Link
          href="/billing"
          className="mt-2 inline-flex w-full items-center justify-center surface-card px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted"
        >
          عرض الخطط والتجربة المجانية
        </Link>
      )}
    </section>
  );
}

function friendlySyncError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('subscription_required')) {
    return 'المزامنة اليدوية متاحة بعد بدء التجربة أو تفعيل الاشتراك.';
  }
  if (normalized.includes('quota_exceeded')) {
    return 'استخدمت حد المزامنة المتاح لهذه الفترة. سيُفتح الحد تلقائياً عند بداية الفترة التالية.';
  }
  if (normalized.includes('usage_storage_unavailable')) {
    return 'تعذر التحقق من حد الاستخدام بأمان الآن. أعد المحاولة بعد قليل.';
  }
  if (normalized.includes('user_permission_denied') || normalized.includes('permission')) {
    return 'Google رفضت قراءة هذا الحساب بهذا الربط. غالباً الحساب تحت مدير مختلف أو البريد لا يملك صلاحية API عليه؛ أعد ربط Google Ads بالبريد/المدير الصحيح أو سمّه يدوياً من الإعدادات.';
  }
  if (normalized.includes('customer_not_enabled')) {
    return 'هذا الحساب غير مفعّل أو متوقف في Google Ads، لذلك لا يمكن تحديث بياناته الآن.';
  }
  if (normalized.includes('requested_metrics_for_manager')) {
    return 'هذا حساب إداري، اختر حساب عميل غير إداري لقراءة الأداء.';
  }
  if (
    normalized.includes('refresh token') ||
    normalized.includes('revoked') ||
    normalized.includes('unauthorized_client') ||
    normalized.includes('invalid_client') ||
    normalized.includes('invalid_grant') ||
    // OAUTH_TOKEN_REVOKED and friends surface as AUTHENTICATION_ERROR, which
    // googleAdsAuthNeedsReconnect already treats as reconnect-worthy; the copy
    // must match so the reconnect CTA and message agree.
    normalized.includes('authentication_error')
  ) {
    return 'انتهت صلاحية ربط Google Ads. أعد الربط من زر إضافة حساب.';
  }
  if (normalized.includes('client secret')) {
    return 'إعداد Google OAuth في السيرفر كان غير متطابق مع الربط. تم تسجيل الخطأ وسنصلحه من إعدادات المنصة قبل إعادة المحاولة.';
  }
  return 'تعذر تحديث بيانات الحساب الآن. أعد الربط إذا استمرت المشكلة.';
}
