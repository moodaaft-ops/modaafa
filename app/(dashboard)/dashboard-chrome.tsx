'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  CreditCard,
  HelpCircle,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Menu,
  Settings,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { RouteProgress } from '@/lib/ui/route-progress';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { trapTabKey } from '@/lib/ui/focus-trap';
import { cn } from '@/lib/utils';
import { trialLabelAr } from '@/lib/ui/plural-ar';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { AccountSwitcher } from './account-switcher';
import { WelcomeTour, startWelcomeTour } from './welcome-tour';
import { LogoLockup, LogoMark } from '@/lib/ui/logo';

/** Nav hrefs that the first-run tour spotlights, mapped to their anchor id. */
const TOUR_ANCHORS: Record<string, string> = {
  '/audit': 'nav-audit',
  '/optimizer': 'nav-optimizer',
  '/assistant': 'nav-assistant',
};

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: string };

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'العمل اليومي',
    items: [
      { href: '/dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
      { href: '/assistant', label: 'المساعد الذكي', icon: MessageCircle },
      { href: '/audit', label: 'فحص الحساب', icon: ShieldCheck },
      { href: '/optimizer', label: 'الموافقات', icon: Zap },
      { href: '/autopilot', label: 'الطيار الآلي', icon: Bot },
    ],
  },
  {
    label: 'البيانات',
    items: [
      { href: '/campaigns', label: 'الحملات', icon: Megaphone },
      { href: '/reports', label: 'التقارير', icon: BarChart3 },
    ],
  },
  {
    label: 'الحساب',
    items: [
      { href: '/billing', label: 'الفوترة والاشتراك', icon: CreditCard },
      { href: '/settings', label: 'الإعدادات', icon: Settings },
    ],
  },
];

export function DashboardChrome({
  brandName,
  userEmail,
  accounts,
  revokedAccounts,
  pausedAccounts = [],
  selectedCustomerId,
  isOperator = false,
  trialDaysLeft = null,
  children,
}: {
  brandName: string;
  userEmail: string;
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  pausedAccounts?: AdsAccountSummary[];
  selectedCustomerId: string | null;
  isOperator?: boolean;
  /** Whole days left in the free trial; null when not trialing. */
  trialDaysLeft?: number | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // The operations center is owner-only; the page itself re-checks the
  // server-side allowlist, this only decides whether to show the link.
  const visibleNavGroups = isOperator
    ? navGroups.map((group) =>
        group.label === 'الحساب'
          ? { ...group, items: [...group.items, { href: '/operations', label: 'مركز التشغيل', icon: Activity } as NavItem] }
          : group
      )
    : navGroups;
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const mainColumnRef = useRef<HTMLDivElement>(null);
  const drawerWasOpen = useRef(false);

  // The mobile drawer is a modal surface: Escape must close it, matching the
  // account-switcher dropdown which already handles Escape and outside clicks.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
      else if (drawerRef.current) trapTabKey(event, drawerRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  // The drawer is modal on mobile: the page behind it must not remain
  // keyboard- or screen-reader-accessible while the overlay is open.
  useEffect(() => {
    const mainColumn = mainColumnRef.current;
    if (!mobileOpen || !mainColumn) return;

    const inertTarget = mainColumn as HTMLDivElement & { inert: boolean };
    const wasInert = inertTarget.inert;
    inertTarget.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      inertTarget.inert = wasInert;
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  // Move focus into the drawer when it opens and restore it to the menu button
  // when it closes. Announcing `role="dialog" aria-modal` without moving focus
  // left keyboard and screen-reader users tabbing through the page content
  // sitting behind the overlay. Guarded so the initial (closed) mount does not
  // steal focus to the menu button on every page load.
  useEffect(() => {
    if (mobileOpen) {
      drawerWasOpen.current = true;
      closeButtonRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [mobileOpen]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const selectedAccountLabel = (() => {
    const match = accounts.find((account) => account.customer_id === selectedCustomerId);
    return match ? googleAdsAccountDisplayName(match) : null;
  })();

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const brand = (
    <Link href="/dashboard" className="group flex min-w-0 items-center gap-2.5">
      <span className="flex min-w-0 flex-col gap-1">
        <LogoLockup height={26} alt="مُضاعِف" priority />
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">{brandName}</span>
      </span>
    </Link>
  );

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <RouteProgress />

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[#0E1426]/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — in-flow on desktop, slide-in drawer on mobile */}
      <aside
        ref={drawerRef}
        className={cn(
          // The sidebar is navy in both themes: the `dark` class re-scopes the
          // colour tokens for everything inside it (switcher, logo, buttons).
          'dark z-50 flex w-[268px] flex-shrink-0 flex-col border-e border-border bg-background text-foreground',
          // `start-0`, not `end-0`: in RTL the logical start edge is the right
          // one, which is where a drawer is expected from.
          'fixed inset-y-0 start-0 transition-transform duration-200 ease-out',
          // `lg:relative` keeps the rail in normal flow on desktop.
          'lg:relative lg:z-auto lg:w-[252px] lg:transition-none',
          // `max-lg:` scopes the drawer transform to small screens only; an
          // `rtl:` variant out-ranks the plain `lg:` rule and hid the desktop rail.
          mobileOpen
            ? 'translate-x-0'
            : 'max-lg:rtl:translate-x-full max-lg:ltr:-translate-x-full'
        )}
        id="primary-navigation"
        aria-label="التنقل الرئيسي"
        // Only a modal dialog while it is the mobile drawer. On desktop it is a
        // permanent navigation landmark, so announcing it as a dialog there
        // destroyed its semantics.
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
      >
        <div className="relative flex h-14 items-center justify-between gap-2 border-b border-border px-3">
          {brand}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setMobileOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label="إغلاق القائمة"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative" data-tour="account-switcher">
          <AccountSwitcher
            accounts={accounts}
            revokedAccounts={revokedAccounts}
            pausedAccounts={pausedAccounts}
            selectedCustomerId={selectedCustomerId}
          />
        </div>

        <nav className="relative flex-1 space-y-5 overflow-y-auto px-2.5 py-4 scrollbar-thin">
          {visibleNavGroups.map((group) => (
            <div key={group.label}>
              <div className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase text-muted-foreground/60">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      data-tour={TOUR_ANCHORS[item.href]}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors duration-150',
                        active
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      {/* Signal marker: the current page, and the only yellow in the rail. */}
                      {active && <span className="absolute inset-y-0 start-0 w-[3px] bg-signal" aria-hidden />}
                      <Icon
                        className={cn(
                          'h-4 w-4 flex-shrink-0 transition-colors duration-150',
                          active ? 'text-foreground' : 'text-muted-foreground/70 group-hover:text-foreground'
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                      {item.badge && (
                        <span className="ms-auto rounded-md border border-border-strong px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="relative border-t border-border p-2.5">
          {trialDaysLeft !== null && (
            <Link
              href="/billing"
              className="mb-2 flex items-center gap-2 rounded-md border border-border-strong px-2.5 py-2 text-[12px] leading-5 text-foreground transition-colors hover:bg-muted"
            >
              <span className="status-square flex-shrink-0 text-signal" aria-hidden />
              <span className="min-w-0">
                <span className="block font-semibold">تجربة مجانية</span>
                <span className="block text-[11px] text-muted-foreground">{trialLabelAr(trialDaysLeft)}</span>
              </span>
            </Link>
          )}
          <div className="mb-2 flex items-center gap-2 rounded-md px-1.5 py-1.5">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-bold text-foreground">
              {(brandName || 'M').trim().charAt(0).toUpperCase()}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              dir="ltr"
              title={userEmail}
            >
              {userEmail}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle className="h-8 w-8 flex-shrink-0" />
            <button
              type="button"
              onClick={startWelcomeTour}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              aria-label="جولة تعريفية: شرح المنصة"
              title="شرح المنصة"
            >
              <HelpCircle className="h-[18px] w-[18px]" />
            </button>
            <form action="/api/auth/signout" method="post" className="min-w-0 flex-1">
              <PendingSubmitButton
                pendingLabel="جاري الخروج..."
                className="h-8 w-full rounded-md px-2.5 text-start text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                تسجيل الخروج
              </PendingSubmitButton>
            </form>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div ref={mainColumnRef} className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex h-14 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <LogoMark size={26} alt="شعار مُضاعِف" />
            <span className="text-sm font-semibold">مُضاعِف</span>
          </Link>
          {/* The selected account is the single most important piece of context
              in the product; on mobile it was only reachable through the
              drawer. */}
          {selectedAccountLabel ? (
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              data-tour="account-switcher"
              className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate px-2 text-[12px] font-medium text-foreground"
              aria-label={`الحساب الإعلاني: ${selectedAccountLabel}. اضغط للتبديل`}
            >
              <span className="status-square flex-shrink-0 text-signal" aria-hidden />
              <span className="truncate">{selectedAccountLabel}</span>
            </button>
          ) : (
            <span className="flex-1" />
          )}
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <ThemeToggle className="h-9 w-9" />
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-foreground transition-colors hover:bg-surface"
              aria-label="فتح القائمة"
              aria-expanded={mobileOpen}
              aria-controls="primary-navigation"
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Extra bottom padding on mobile so content clears the tab bar. */}
        <main className="flex-1 overflow-y-auto pb-16 scrollbar-thin lg:pb-0">{children}</main>

        {/* Mobile bottom tab bar — the four daily-work routes one tap away,
            instead of open-drawer → find item. Desktop keeps the sidebar. */}
        <nav
          className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-background lg:hidden"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          aria-label="التنقل السريع"
        >
          {[
            { href: '/dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
            { href: '/assistant', label: 'المساعد', icon: MessageCircle },
            { href: '/audit', label: 'الفحص', icon: ShieldCheck },
            { href: '/optimizer', label: 'الموافقات', icon: Zap },
          ].map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                data-tour={TOUR_ANCHORS[item.href]}
                className={cn(
                  'relative flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[10.5px] font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {active && <span className="absolute inset-x-4 top-0 h-[3px] bg-signal" aria-hidden />}
                <Icon className={cn('h-5 w-5', active ? 'text-foreground' : 'text-muted-foreground/80')} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* First-run walkthrough; also replayable from the "شرح المنصة" button. */}
      <WelcomeTour />
    </div>
  );
}
