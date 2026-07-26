'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  CreditCard,
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

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const brand = (
    <Link href="/dashboard" className="flex items-center gap-3">
      <span className="relative">
        <Image src="/logo-mark.svg" alt="مُضاعِف" width={40} height={40} className="h-10 w-10 rounded-xl shadow-soft" priority />
      </span>
      <span className="min-w-0">
        <span className="block font-bold leading-tight text-foreground">مُضاعِف</span>
        <span className="block truncate text-xs text-muted-foreground">{brandName}</span>
      </span>
    </Link>
  );

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <RouteProgress />

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink-900/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — in-flow on desktop, slide-in drawer on mobile */}
      <aside
        className={cn(
          'z-50 flex w-72 flex-shrink-0 flex-col border-e border-border bg-[hsl(var(--sidebar))]',
          // `inset-y-0 end-0` + rtl:/ltr: transforms keep the drawer sliding
          // in from the correct edge. `right-0` with `translate-x-full` only
          // worked in RTL; in an English layout the drawer would have slid in
          // from the wrong side and covered the content.
          'fixed inset-y-0 end-0 shadow-pop transition-transform duration-200 ease-out',
          'lg:static lg:z-auto lg:w-64 lg:shadow-none lg:transition-none',
          mobileOpen
            ? 'translate-x-0'
            : 'rtl:translate-x-full ltr:-translate-x-full lg:translate-x-0'
        )}
        aria-label="التنقل الرئيسي"
        role="dialog"
        aria-modal={mobileOpen ? true : undefined}
        aria-hidden={!mobileOpen ? undefined : undefined}
      >
        {/* subtle brand wash at the top */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-brand-soft opacity-70" aria-hidden />

        <div className="relative flex items-center justify-between gap-2 border-b border-border/70 p-4 lg:p-5">
          {brand}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted lg:hidden"
            aria-label="إغلاق القائمة"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative">
          <AccountSwitcher accounts={accounts} selectedCustomerId={selectedCustomerId} />
        </div>

        <nav className="relative flex-1 space-y-6 overflow-y-auto px-3 py-5 scrollbar-thin">
          {navGroups.map((group) => (
            <div key={group.label}>
              <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                        active
                          ? 'bg-brand-50 font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      {active && (
                        <span className="absolute inset-y-1.5 start-0 w-1 rounded-full bg-brand-600 dark:bg-brand-400" aria-hidden />
                      )}
                      <Icon
                        className={cn(
                          'h-5 w-5 flex-shrink-0 transition-colors',
                          active ? 'text-brand-600 dark:text-brand-300' : 'text-muted-foreground/70 group-hover:text-foreground'
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                      {item.badge && (
                        <span className="ms-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
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

        <div className="relative space-y-2 border-t border-border/70 p-3">
          <ThemeToggle showLabel className="w-full justify-start" />
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[11px] font-bold text-white">
              {(brandName || 'M').trim().charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground" dir="ltr" title={userEmail}>
              {userEmail}
            </span>
          </div>
          <form action="/api/auth/signout" method="post">
            <PendingSubmitButton
              pendingLabel="جاري الخروج..."
              className="w-full rounded-lg px-3 py-2 text-start text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              تسجيل الخروج
            </PendingSubmitButton>
          </form>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur-xl lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Image src="/logo-mark.svg" alt="مُضاعِف" width={32} height={32} className="h-8 w-8 rounded-lg" />
            <span className="font-bold">مُضاعِف</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted"
              aria-label="فتح القائمة"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>
    </div>
  );
}
