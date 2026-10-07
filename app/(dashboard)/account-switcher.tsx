'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import {
  Building2,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  CircleAlert,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import { searchGoogleAdsAccounts } from '@/lib/accounts/search';
import {
  formatGoogleAdsCustomerId,
  googleAdsAccountDisplayName,
  googleAdsAccountNameMissing,
} from '@/lib/accounts/display';
import { accountsAr } from '@/lib/ui/plural-ar';
import { cn, formatDateShortAr } from '@/lib/utils';

type AccountLamp = { square: string; label: string | null };

/** Status square colour and short label for one account row. */
function accountLamp(account: AdsAccountSummary, kind: 'active' | 'revoked' | 'paused'): AccountLamp {
  if (kind === 'revoked') return { square: 'text-danger', label: 'يحتاج تجديد الربط' };
  if (kind === 'paused') return { square: 'text-muted-foreground', label: 'موقوف أو مغلق في Google Ads' };
  const google = (account.google_status ?? '').toUpperCase();
  if (google === 'SUSPENDED') return { square: 'text-danger', label: 'معلّق من Google' };
  if (google === 'CANCELED' || google === 'CLOSED') return { square: 'text-muted-foreground', label: 'مغلق في Google Ads' };
  return { square: 'text-signal', label: null };
}

export function AccountSwitcher({
  accounts,
  revokedAccounts,
  pausedAccounts = [],
  selectedCustomerId,
}: {
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  pausedAccounts?: AdsAccountSummary[];
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

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
  const filteredAccounts = useMemo(() => searchGoogleAdsAccounts(accounts, query), [accounts, query]);
  // Revoked and paused accounts are listed for visibility but can never be selected.
  const filteredRevoked = useMemo(() => searchGoogleAdsAccounts(revokedAccounts, query), [revokedAccounts, query]);
  const filteredPaused = useMemo(() => searchGoogleAdsAccounts(pausedAccounts, query), [pausedAccounts, query]);
  const nothingMatches = filteredAccounts.length + filteredRevoked.length + filteredPaused.length === 0;

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery('');
    setEditingId(null);
    setRenameError('');
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
          setNameRepairMessage('انتهت صلاحية ربط Google Ads. جدّد الربط لتحديث الأسماء والبيانات.');
          return;
        }

        if (Number(payload.updated ?? 0) > 0) {
          const unresolved = Number(payload.unresolved ?? 0);
          setNameRepairMessage(
            unresolved > 0
              ? `تم تحديث ${payload.updated} اسم، وبقي ${accountsAr(unresolved)} لا ترجع Google اسمه تلقائياً`
              : `تم تحديث ${payload.updated} اسم من Google`
          );
          startTransition(() => router.refresh());
        } else {
          setNameRepairMessage('الحسابات المتبقية لا ترجع Google أسماءها، سمّها من القائمة بزر القلم');
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

  function startRename(account: AdsAccountSummary) {
    setEditingId(account.customer_id);
    setDraftName(googleAdsAccountNameMissing(account) ? '' : (account.customer_name ?? '').trim());
    setRenameError('');
  }

  async function submitRename(customerId: string) {
    const name = draftName.trim();
    if (name.length < 2 || name.length > 120) {
      setRenameError('اكتب اسماً من حرفين إلى 120 حرفاً');
      return;
    }
    setRenaming(true);
    setRenameError('');
    try {
      const response = await fetch('/api/accounts/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ customerId, customerName: name }),
      });
      if (!response.ok) throw new Error('rename_failed');
      setEditingId(null);
      startTransition(() => router.refresh());
    } catch {
      setRenameError('تعذر حفظ الاسم. حاول مرة أخرى.');
    } finally {
      setRenaming(false);
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
        setNameRepairMessage('انتهت صلاحية ربط Google Ads. جدّد الربط لتحديث الأسماء والبيانات.');
        return;
      }
      if (Number(payload.updated ?? 0) > 0) {
        setNameRepairMessage(`تم تحديث ${payload.updated} اسم من Google`);
        startTransition(() => router.refresh());
      } else {
        setNameRepairMessage('الحسابات المتبقية لا ترجع Google أسماءها، سمّها من القائمة بزر القلم.');
      }
    } catch {
      setNameRepairMessage('تعذر تحديث الأسماء الآن. حاول لاحقاً أو سمّها بزر القلم.');
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

  const pausedNotice =
    pausedAccounts.length > 0 ? (
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        {`${googleAdsAccountDisplayName(pausedAccounts[0])} (${formatGoogleAdsCustomerId(pausedAccounts[0].customer_id)})`}
        {pausedAccounts.length > 1 ? ` و${accountsAr(pausedAccounts.length - 1)} آخر` : ''}
        {' غير مفعّل أو متوقف في Google Ads، لذلك أوقفنا تحديثه وتحليله حتى تعيد تفعيله وتجدد الربط.'}
      </p>
    ) : null;

  if (accounts.length === 0) {
    return (
      <div className="mx-4 mt-4 rounded-md border border-border bg-muted p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className={cn('status-square flex-shrink-0', revokedAccount ? 'text-danger' : 'text-signal')} aria-hidden />
          {revokedAccount ? 'انتهت صلاحية ربط Google Ads' : 'لا يوجد حساب إعلاني'}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {revokedAccount
            ? `انتهت صلاحية الربط لحساب ${revokedAccountLabel}${
                revokedAccounts.length > 1 ? ` و${accountsAr(revokedAccounts.length - 1)} آخر` : ''
              }. جدّد الربط لاستعادة البيانات.`
            : 'اربط Google Ads حتى تظهر بيانات الأداء والتوصيات.'}
        </p>
        {pausedNotice}
        <Link
          href="/onboarding/connect"
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {revokedAccount ? <RefreshCw className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {revokedAccount ? 'تجديد الربط' : 'ربط Google Ads'}
        </Link>
      </div>
    );
  }

  const selectedMissingName = selected ? googleAdsAccountNameMissing(selected) : false;
  const selectedLamp = selected ? accountLamp(selected, 'active') : null;
  const switchingTo = selecting ? accounts.find((account) => account.customer_id === value) : null;

  function renderRow(account: AdsAccountSummary, kind: 'active' | 'revoked' | 'paused') {
    const selectable = kind === 'active';
    const active = selectable && account.customer_id === value;
    const lamp = accountLamp(account, kind);
    const missing = googleAdsAccountNameMissing(account);

    if (selectable && editingId === account.customer_id) {
      return (
        <form
          key={account.customer_id}
          className="rounded-md border border-border-strong bg-card p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename(account.customer_id);
          }}
        >
          <label className="block text-[11px] font-semibold text-muted-foreground" htmlFor={`rename-${account.customer_id}`}>
            اسم الحساب
          </label>
          <input
            id={`rename-${account.customer_id}`}
            autoFocus
            value={draftName}
            maxLength={120}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setEditingId(null);
              }
            }}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {renameError && <p className="mt-1 text-[11px] text-danger">{renameError}</p>}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="submit"
              disabled={renaming}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" />
              {renaming ? 'جاري الحفظ...' : 'حفظ'}
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
              إلغاء
            </button>
          </div>
        </form>
      );
    }

    return (
      <div key={account.customer_id} className="flex items-stretch gap-1">
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-disabled={!selectable}
          onClick={() => selectable && selectAccount(account.customer_id)}
          disabled={selecting || !selectable}
          className={cn(
            'relative flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-start transition-colors',
            selectable ? 'disabled:cursor-wait disabled:opacity-70' : 'cursor-default opacity-70',
            active ? 'bg-muted' : selectable ? 'hover:bg-muted/60' : ''
          )}
        >
          {active && <span className="absolute inset-y-0 start-0 w-[3px] bg-signal" aria-hidden />}
          <span className={cn('status-square mt-1.5 flex-shrink-0', lamp.square)} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-foreground">
              {googleAdsAccountDisplayName(account)}
            </span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground" dir="ltr">
              {formatGoogleAdsCustomerId(account.customer_id)}
            </span>
            {lamp.label && <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{lamp.label}</span>}
            {missing && selectable && (
              <span className="mt-0.5 block text-[10.5px] text-muted-foreground">Google لم ترجع اسماً لهذا الحساب</span>
            )}
          </span>
        </button>
        {selectable && (
          <button
            type="button"
            onClick={() => startRename(account)}
            className="flex w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`تعديل اسم ${googleAdsAccountDisplayName(account)}`}
            title="تعديل الاسم"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <section ref={containerRef} className="relative mx-4 mt-4 rounded-md border border-border bg-muted p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground">الحساب الإعلاني</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground" aria-live="polite">
          {busy && <RefreshCw className="h-3 w-3 animate-spin" />}
          {accountsAr(accounts.length)}
        </span>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 surface-card px-2.5 py-2 text-start transition hover:border-border-strong"
        >
          <span className={cn('status-square flex-shrink-0', selectedLamp?.square ?? 'text-muted-foreground')} aria-hidden />
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
          <div className="absolute inset-x-0 top-full z-50 mt-2 surface-card p-2">
            <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-2">
              <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ابحث بالاسم أو الرقم"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                aria-label="ابحث عن حساب"
              />
            </label>

            <div className="mt-2 max-h-72 space-y-1 overflow-y-auto scrollbar-thin" role="listbox" aria-label="الحسابات الإعلانية">
              {filteredAccounts.map((account) => renderRow(account, 'active'))}
              {filteredRevoked.map((account) => renderRow(account, 'revoked'))}
              {filteredPaused.map((account) => renderRow(account, 'paused'))}
              {nothingMatches && (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">لا توجد نتيجة مطابقة</div>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
              <Link
                href="/onboarding/connect"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold text-foreground hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                ربط Google Ads
              </Link>
              {hasMissingNames && (
                <button
                  type="button"
                  onClick={repairNamesManually}
                  disabled={repairingNames}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold text-foreground hover:bg-muted disabled:opacity-60"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', repairingNames && 'animate-spin')} />
                  جلب أسماء {accountsAr(missingCount)}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {revokedAccount && (
        <div className="mt-3 rounded-md border border-border-strong bg-card px-2.5 py-2 text-[11px] leading-5 text-foreground">
          <div className="flex items-start gap-2">
            <span className="status-square mt-1.5 flex-shrink-0 text-danger" aria-hidden />
            <span>
              انتهت صلاحية ربط Google Ads لحساب {revokedAccountLabel}
              {revokedAccounts.length > 1 ? ` و${accountsAr(revokedAccounts.length - 1)} آخر` : ''}.
            </span>
          </div>
          <Link
            href="/onboarding/connect"
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            تجديد الربط
          </Link>
        </div>
      )}

      {pausedNotice}

      {selectedMissingName && !open && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="status-square flex-shrink-0 text-signal" aria-hidden />
          بدون اسم من Google
        </p>
      )}

      {(repairingNames || nameRepairMessage) && !open && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-card px-2 py-2 text-[11px] leading-5 text-foreground">
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
        {syncing ? 'جاري تحديث البيانات...' : 'تحديث البيانات'}
      </button>

      <div className="mt-2 min-h-[1rem] text-[11px] leading-5" aria-live="polite">
        {syncedJustNow ? (
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            تم تحديث البيانات الآن
          </span>
        ) : selected?.last_synced_at ? (
          <span className="text-muted-foreground">آخر تحديث: {formatDateShortAr(selected.last_synced_at)}</span>
        ) : (
          <span className="text-muted-foreground">الاختيار يطبّق على كل الصفحات</span>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-danger/40 bg-card px-2 py-2 text-[11px] leading-5 text-danger" role="alert">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {reconnectRequired && (
        <Link
          href="/onboarding/connect"
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          تجديد الربط
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

      {/* Full-screen overlay while the server re-renders for the new account.
          Portalled so the drawer's transform cannot trap a fixed element. */}
      {mounted &&
        selecting &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-[#0E1426]/70 px-6"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 rounded-md border border-border bg-background px-5 py-4 text-sm font-medium text-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>
                جاري التحويل إلى {switchingTo ? googleAdsAccountDisplayName(switchingTo) : 'الحساب المختار'}
              </span>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
}

function friendlySyncError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('subscription_required')) {
    return 'تحديث البيانات اليدوي متاح بعد بدء التجربة أو تفعيل الاشتراك.';
  }
  if (normalized.includes('quota_exceeded')) {
    return 'استخدمت حد تحديث البيانات المتاح لهذه الفترة. يُفتح الحد تلقائياً عند بداية الفترة التالية.';
  }
  if (normalized.includes('usage_storage_unavailable')) {
    return 'تعذر التحقق من حد الاستخدام بأمان الآن. أعد المحاولة بعد قليل.';
  }
  if (normalized.includes('customer_not_enabled')) {
    return 'هذا الحساب غير مفعّل أو متوقف في Google Ads، لذلك لا يمكن تحديث بياناته الآن.';
  }
  if (normalized.includes('user_permission_denied') || normalized.includes('permission')) {
    return 'Google رفضت قراءة هذا الحساب بهذا الربط. غالباً الحساب تحت مدير مختلف أو البريد لا يملك صلاحية عليه. جدّد الربط بالبريد الصحيح.';
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
    return 'انتهت صلاحية ربط Google Ads. جدّد الربط من الزر أدناه.';
  }
  if (normalized.includes('client secret')) {
    return 'تعذر إكمال الربط بسبب إعداد في المنصة. سجلنا الخطأ وسنصلحه، وأعد المحاولة بعد قليل.';
  }
  return 'تعذر تحديث البيانات الآن. جدّد الربط إذا استمرت المشكلة.';
}
