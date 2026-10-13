'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, ChevronsUpDown, CircleAlert, LoaderCircle, LogOut, Moon, Plus, Search, Sun } from 'lucide-react';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import { searchGoogleAdsAccounts } from '@/lib/accounts/search';
import { formatGoogleAdsCustomerId, googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { cn } from '@/lib/utils';

const ROW = 'flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-start text-[14px] transition-colors';

/** Above this many accounts the menu gets a search box. */
const SEARCH_FROM = 6;

/**
 * The account row at the foot of the sidebar, like ChatGPT's profile button:
 * one tap opens a menu above it with the ad accounts to switch between, adding
 * an account, the theme and signing out. Switching is the same call the old
 * switcher made (`/api/accounts/select`, then a refresh of the server parts).
 */
export function AccountMenu({
  userEmail,
  accounts,
  revokedAccounts,
  selectedCustomerId,
}: {
  userEmail: string;
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  selectedCustomerId: string | null;
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [, startTransition] = useTransition();

  const selected = accounts.find((account) => account.customer_id === selectedCustomerId) ?? null;
  const title = selected ? googleAdsAccountDisplayName(selected) : accounts.length ? 'اختر حساب إعلاني' : 'اربط حسابك الإعلاني';
  const initial = (selected?.customer_name?.trim() || userEmail || 'م').charAt(0);
  const visible = useMemo(() => searchGoogleAdsAccounts(accounts, query), [accounts, query]);

  // A finished switch lands as a new selected id from the server.
  useEffect(() => {
    setSwitching(null);
  }, [selectedCustomerId]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  async function choose(customerId: string) {
    if (customerId === selectedCustomerId) {
      close();
      return;
    }
    setError('');
    setSwitching(customerId);
    try {
      const response = await fetch('/api/accounts/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId }),
      });
      if (!response.ok) throw new Error('account_switch_failed');
      close();
      startTransition(() => router.refresh());
    } catch {
      setSwitching(null);
      setError('ما قدرت أبدّل الحساب. جرّب مرة ثانية.');
    }
  }

  const revoked = revokedAccounts[0] ?? null;

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div
          role="menu"
          aria-label="حساباتك"
          className="absolute inset-x-0 bottom-full z-50 mb-2 flex max-h-[min(70dvh,560px)] flex-col overflow-hidden rounded-[16px] border border-border bg-background p-1.5 shadow-[0_18px_44px_-14px_rgba(14,20,38,0.4)] motion-safe:animate-fade-in-fast"
        >
          <p className="truncate px-3 pb-1 pt-2 text-[12.5px] text-muted-foreground">
            <span dir="ltr">{userEmail}</span>
          </p>

          {accounts.length > 0 && (
            <>
              <p className="px-3 pb-1 pt-2 text-[12px] font-semibold text-muted-foreground">
                حساباتك الإعلانية <span className="numeric font-normal">({accounts.length})</span>
              </p>
              {accounts.length > SEARCH_FROM && (
                <label className="mx-1 mb-1 flex h-9 items-center gap-2 rounded-full bg-muted px-3">
                  <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="دوّر بالاسم أو الرقم"
                    aria-label="دوّر عن حساب"
                    className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
                  />
                </label>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {visible.map((account) => {
                  const current = account.customer_id === selectedCustomerId;
                  const busy = switching === account.customer_id;
                  return (
                    <button
                      key={account.customer_id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      disabled={Boolean(switching)}
                      onClick={() => choose(account.customer_id)}
                      className={cn(ROW, 'min-h-12 py-1.5 hover:bg-foreground/[0.06] disabled:cursor-wait', current && 'bg-foreground/[0.06]')}
                    >
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className={cn('block truncate text-[14px]', current && 'font-semibold')}>
                          {googleAdsAccountDisplayName(account)}
                        </span>
                        {/* An inline ltr run keeps the number on the same side as the name. */}
                        <span className="block text-[11.5px] text-muted-foreground">
                          <span className="numeric" dir="ltr">
                            {formatGoogleAdsCustomerId(account.customer_id)}
                          </span>
                        </span>
                      </span>
                      {busy ? (
                        <LoaderCircle className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
                      ) : current ? (
                        <Check className="h-4 w-4 flex-shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
                {visible.length === 0 && <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">ما لقيت حساب بهالاسم.</p>}
              </div>
            </>
          )}

          {error && <p className="px-3 py-1.5 text-[12.5px] font-semibold text-danger">{error}</p>}

          {revoked && (
            <Link href="/onboarding?connect=1" className={cn(ROW, 'mt-1 bg-warning-soft text-[13px] text-warning')}>
              <CircleAlert className="h-4 w-4 flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">انتهى ربط {googleAdsAccountDisplayName(revoked)}، أعد الربط</span>
            </Link>
          )}

          <div className="mt-1 flex-shrink-0 border-t border-border/70 pt-1">
            <Link href="/onboarding?connect=1" role="menuitem" className={cn(ROW, 'hover:bg-foreground/[0.06]')}>
              <Plus className="h-[18px] w-[18px] text-muted-foreground" />
              أضف حساب إعلاني
            </Link>
            <ThemeRow />
            <form action="/api/auth/signout" method="post">
              <button type="submit" role="menuitem" className={cn(ROW, 'hover:bg-foreground/[0.06]')}>
                <LogOut className="h-[18px] w-[18px] text-muted-foreground" />
                تسجيل الخروج
              </button>
            </form>
          </div>
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(ROW, 'min-h-12 py-1.5 hover:bg-foreground/[0.06]', open && 'bg-foreground/[0.06]')}
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-[13px] font-bold text-background">
          {initial}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13.5px] font-semibold">{title}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">
            {accounts.length > 1 ? switchLine(accounts.length) : <span dir="ltr">{userEmail}</span>}
          </span>
        </span>
        <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

/** «بدّل بين حسابين», «بين 4 حسابات», «بين 39 حساب»: Arabic counts its nouns. */
function switchLine(count: number): string {
  if (count === 2) return 'بدّل بين حسابين';
  if (count <= 10) return `بدّل بين ${count} حسابات`;
  return `بدّل بين ${count} حساب`;
}

/** Light or dark, as a menu row. Same storage key and class as the old toggle. */
function ThemeRow() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('modaafa-theme', next ? 'dark' : 'light');
    } catch {
      // private mode: the switch still applies to this page
    }
  }
  return (
    <button type="button" role="menuitem" onClick={toggle} className={cn(ROW, 'hover:bg-foreground/[0.06]')}>
      {dark ? <Sun className="h-[18px] w-[18px] text-muted-foreground" /> : <Moon className="h-[18px] w-[18px] text-muted-foreground" />}
      {dark ? 'الوضع الفاتح' : 'الوضع الداكن'}
    </button>
  );
}
