'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
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
import { cn } from '@/lib/utils';
import { AccountSwitcher } from './account-switcher';
import { WelcomeTour, startWelcomeTour } from './welcome-tour';

/** Nav hrefs that the first-run tour spotlights, mapped to their anchor id. */
const TOUR_ANCHORS: Record<string, string> = {
  '/audit': 'nav-audit',
  '/optimizer': 'nav-optimizer',
  '/assistant': 'nav-assistant',
};

const navGroups: Array<{
  label: string;
  items: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: string }>;
}> = [
  {
    label: 'العمل اليومي',
    items: [
      { href: '/dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
      { href: '/assistant', label: 'المساعد الذكي', icon: MessageCircle },
      { href: '/audit', label: 'فحص الحساب', icon: ShieldCheck },
      { href: '/optimizer', label: 'مركز الموافقات', icon: Zap },
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
  selectedCustomerId,
  children,
}: {
  brandName: string;
  userEmail: string;
  accounts: AdsAccountSummary[];
  selectedCustomerId: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  // The mobile drawer is a modal surface: Escape must close it, matching the
  // account-switcher dropdown which already handles Escape and outside clicks.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
    return match?.customer_name?.trim() || null;
  })();

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const brand = (
    <Link href="/dashboard" className="group flex min-w-0 items-center gap-2.5">
      <Image
        src="/logo-mark.svg"
        alt="شعار مُضاعِف"
        width={30}
        height={30}
        className="h-[30px] w-[30px] flex-shrink-0 rounded-lg"
        priority
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold leading-tight text-foreground">مُضاعِف</span>
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
          className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — in-flow on desktop, slide-in drawer on mobile */}
      <aside
        className={cn(
          'z-50 flex w-[268px] flex-shrink-0 flex-col border-e border-border bg-[hsl(var(--sidebar))]',
          // `start-0`, NOT `end-0`: in RTL the logical start edge is the RIGHT
          // one, which is the side the menu button lives on and the side a
          // drawer is expected from. `end-0` anchors it to the left in RTL, so
          // the closed `translate-x-full` pushed it INTO view instead of out.
          'fixed inset-y-0 start-0 shadow-pop transition-transform duration-200 ease-out',
          // `lg:relative`, NOT `lg:static`: the rail's decorative wash below is
          // `absolute inset-x-0`, and a static aside is not a containing block —
          // so on desktop the wash escaped the rail, resolved against the page,
          // and painted a full-width green band across the app just under the
          // sticky header (obvious in light mode, muddy in dark). `relative`
          // lays out identically to `static` here and re-anchors the child.
          'lg:relative lg:z-auto lg:w-[252px] lg:shadow-none lg:transition-none',
          // `max-lg:` scopes the drawer transform to small screens only.
          // Using `rtl:` + `lg:translate-x-0` did NOT work: the rtl variant
          // compiles to `[dir=rtl] .rtl\:…`, whose specificity beats the
          // media-query-only `lg:` rule, so the sidebar stayed translated off
          // screen on desktop and the whole rail disappeared.
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
        {/* A single faint accent wash at the top of the rail — the only
            decoration in the shell. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-brand-soft opacity-60" aria-hidden />

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
          <AccountSwitcher accounts={accounts} selectedCustomerId={selectedCustomerId} />
        </div>

        <nav className="relative flex-1 space-y-5 overflow-y-auto px-2.5 py-4 scrollbar-thin">
          {navGroups.map((group) => (
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
                        // The active item is a raised surface, not a coloured
                        // block: it reads as the selected row of a tool rather
                        // than a highlighted link.
                        'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors duration-150',
                        active
                          ? 'bg-muted font-medium text-foreground shadow-[inset_0_1px_0_0_hsl(var(--edge-highlight))]'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      {active && (
                        <span
                          className="absolute inset-y-1.5 start-0 w-[2px] rounded-full bg-primary"
                          aria-hidden
                        />
                      )}
                      <Icon
                        className={cn(
                          'h-4 w-4 flex-shrink-0 transition-colors duration-150',
                          active ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground'
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                      {item.badge && (
                        <span className="ms-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
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
          <div className="mb-2 flex items-center gap-2 rounded-md px-1.5 py-1.5">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-[10px] font-bold text-primary ring-1 ring-inset ring-primary/25">
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
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex h-14 items-center justify-between gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-xl lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Image src="/logo-mark.svg" alt="شعار مُضاعِف" width={26} height={26} className="h-[26px] w-[26px] rounded-md" />
            <span className="text-sm font-semibold">مُضاعِف</span>
          </Link>
          {/* The selected account is the single most important piece of context
              in the product; on mobile it was only reachable through the
              drawer. */}
          {selectedAccountLabel && (
            <span className="min-w-0 flex-1 truncate px-2 text-center text-[11px] text-muted-foreground">
              {selectedAccountLabel}
            </span>
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
          className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-background/90 backdrop-blur-xl lg:hidden"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          aria-label="التنقل السريع"
        >
          {[
            { href: '/dashboard', label: 'الرئيسية', icon: LayoutDashboard },
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
                className={cn(
                  'flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[10.5px] font-medium transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <Icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-muted-foreground/80')} />
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
