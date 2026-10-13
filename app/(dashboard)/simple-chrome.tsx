'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, CreditCard, Home, Megaphone, Menu, MessageCircle, Settings, X } from 'lucide-react';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import { ASSISTANT } from '@/lib/assistant/persona';
import { LogoMark } from '@/lib/ui/logo';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { RouteProgress } from '@/lib/ui/route-progress';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { trapTabKey } from '@/lib/ui/focus-trap';
import { SUPPORT_WHATSAPP_NUMBER } from '@/lib/support/contact';
import { cn } from '@/lib/utils';
import { AccountSwitcher } from './account-switcher';

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };

/**
 * The simple shell: one header and a short menu. Everything a customer does
 * every day lives on /home with «زياد»; the menu only holds the four places
 * someone goes on purpose. The nine-item sidebar, the bottom tab bar and the
 * spotlight tour are not rendered here at all.
 */
const ITEMS: Item[] = [
  { href: '/home', label: 'الرئيسية', icon: Home },
  { href: '/campaigns', label: 'حملاتي', icon: Megaphone },
  { href: '/reports', label: 'التقارير', icon: BarChart3 },
  { href: '/billing', label: 'الاشتراك', icon: CreditCard },
  { href: '/settings', label: 'الإعدادات', icon: Settings },
];

export function SimpleChrome({
  brandName,
  userEmail,
  accounts,
  revokedAccounts,
  pausedAccounts = [],
  selectedCustomerId,
  isOperator = false,
  children,
}: {
  brandName: string;
  userEmail: string;
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  pausedAccounts?: AdsAccountSummary[];
  selectedCustomerId: string | null;
  isOperator?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const items = isOperator ? [...ITEMS, { href: '/operations', label: 'مركز التشغيل', icon: Activity }] : ITEMS;
  const selected = accounts.find((account) => account.customer_id === selectedCustomerId);
  const accountLabel = selected?.customer_name?.trim() || null;

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      else if (panelRef.current) trapTabKey(event, panelRef.current);
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      closeRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background">
      <RouteProgress />
      <header className="z-30 flex h-14 flex-shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <Link href="/home" className="flex min-h-10 items-center gap-2" aria-label="الرئيسية">
          <LogoMark size={24} alt="" />
          <span className="text-[15px] font-bold">مُضاعِف</span>
        </Link>
        {accountLabel && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="min-w-0 flex-1 truncate text-center text-[12.5px] text-muted-foreground hover:text-foreground"
            title="بدّل الحساب"
          >
            {accountLabel}
          </button>
        )}
        {!accountLabel && <span className="flex-1" />}
        <nav className="hidden items-center gap-1 lg:flex" aria-label="التنقل">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'px-3 py-2 text-[13.5px] font-semibold transition-colors',
                isActive(item.href) ? 'text-foreground underline decoration-signal decoration-2 underline-offset-[10px]' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="simple-menu"
          aria-label="القائمة"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center border border-border bg-card text-foreground"
        >
          <Menu className="h-4 w-4" />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</main>

      {open && <div className="fixed inset-0 z-40 bg-foreground/30" aria-hidden onClick={() => setOpen(false)} />}
      <div
        ref={panelRef}
        id="simple-menu"
        role="dialog"
        aria-modal="true"
        aria-label="القائمة"
        className={cn(
          'fixed inset-y-0 start-0 z-50 flex w-[min(340px,88vw)] flex-col border-e border-border bg-background transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'invisible rtl:translate-x-full ltr:-translate-x-full'
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold">{brandName}</p>
            <p className="truncate text-[11.5px] text-muted-foreground" dir="ltr">
              {userEmail}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => setOpen(false)}
            aria-label="سكّر القائمة"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center border border-border"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-border">
          <AccountSwitcher
            accounts={accounts}
            revokedAccounts={revokedAccounts}
            pausedAccounts={pausedAccounts}
            selectedCustomerId={selectedCustomerId}
          />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="الأقسام">
          {items.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[52px] items-center gap-3 px-3 text-[15px] font-semibold',
                  active ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/60'
                )}
              >
                <Icon className={cn('h-5 w-5', active ? 'text-foreground' : 'text-muted-foreground')} />
                {item.label}
              </Link>
            );
          })}
          <a
            href={`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 flex min-h-[52px] items-center gap-3 px-3 text-[15px] font-semibold text-foreground hover:bg-muted/60"
          >
            <MessageCircle className="h-5 w-5 text-muted-foreground" />
            كلّم فريقنا على الواتساب
          </a>
          <p className="px-3 pt-3 text-[12.5px] leading-6 text-muted-foreground">
            أي شي تبيه في حسابك اطلبه من {ASSISTANT.name} في الرئيسية.
          </p>
        </nav>

        <div className="flex items-center gap-2 border-t border-border p-3">
          <ThemeToggle className="h-10 w-10 flex-shrink-0" />
          <form action="/api/auth/signout" method="post" className="min-w-0 flex-1">
            <PendingSubmitButton
              pendingLabel="أطلّعك…"
              className="h-10 w-full px-3 text-start text-[13.5px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              تسجيل الخروج
            </PendingSubmitButton>
          </form>
        </div>
      </div>
    </div>
  );
}
