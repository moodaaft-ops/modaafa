'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  ChevronDown,
  CreditCard,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  Settings,
  SquarePen,
  X,
} from 'lucide-react';
import type { AdsAccountSummary } from '@/lib/accounts/selection';
import type { RecentChat } from '@/lib/chat-first/sessions';
import { LogoMark } from '@/lib/ui/logo';
import { RouteProgress } from '@/lib/ui/route-progress';
import { ThemeToggle } from '@/lib/ui/theme-toggle';
import { trapTabKey } from '@/lib/ui/focus-trap';
import { SUPPORT_WHATSAPP_NUMBER } from '@/lib/support/contact';
import { cn } from '@/lib/utils';
import { AccountSwitcher } from './account-switcher';

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };

/**
 * The simple shell, laid out like ChatGPT: a sidebar on the right with «محادثة
 * جديدة», the places someone goes on purpose and their past conversations,
 * and the page (on /home, the conversation with «مُضاعِف») filling the rest.
 * On a phone the sidebar is a drawer behind the menu button.
 */
const ITEMS: Item[] = [
  { href: '/campaigns', label: 'حملاتي', icon: Megaphone },
  { href: '/reports', label: 'التقارير', icon: BarChart3 },
  { href: '/billing', label: 'الاشتراك', icon: CreditCard },
  { href: '/settings', label: 'الإعدادات', icon: Settings },
];

const ROW = 'flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-start text-[14px] transition-colors';
const ROW_IDLE = 'text-foreground hover:bg-foreground/[0.06]';
const ROW_ACTIVE = 'bg-foreground/[0.08] font-semibold text-foreground';

export function SimpleChrome({
  brandName,
  userEmail,
  accounts,
  revokedAccounts,
  pausedAccounts = [],
  selectedCustomerId,
  isOperator = false,
  recentChats = [],
  children,
}: {
  brandName: string;
  userEmail: string;
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  pausedAccounts?: AdsAccountSummary[];
  selectedCustomerId: string | null;
  isOperator?: boolean;
  recentChats?: RecentChat[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const selected = accounts.find((account) => account.customer_id === selectedCustomerId);
  const accountLabel = selected?.customer_name?.trim() || null;
  const activeChat = pathname === '/home' ? searchParams.get('c') : null;

  useEffect(() => {
    setOpen(false);
  }, [pathname, searchParams]);

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

  const sidebar = (onClose?: () => void) => (
    <Sidebar
      brandName={brandName}
      userEmail={userEmail}
      accounts={accounts}
      revokedAccounts={revokedAccounts}
      pausedAccounts={pausedAccounts}
      selectedCustomerId={selectedCustomerId}
      accountLabel={accountLabel}
      items={isOperator ? [...ITEMS, { href: '/operations', label: 'مركز التشغيل', icon: Activity }] : ITEMS}
      pathname={pathname}
      activeChat={activeChat}
      recentChats={recentChats}
      onClose={onClose}
      closeRef={onClose ? closeRef : undefined}
    />
  );

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <RouteProgress />
      {/* RTL: the first child sits on the right, where ChatGPT keeps its sidebar on the left. */}
      <aside className="hidden w-[272px] flex-shrink-0 border-e border-border/60 bg-muted/45 lg:flex lg:flex-col">
        {sidebar()}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-shrink-0 items-center gap-1 px-2 lg:hidden">
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-controls="simple-menu"
            aria-label="القائمة"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-foreground hover:bg-foreground/[0.06]"
          >
            <Menu className="h-5 w-5" />
          </button>
          <p className="min-w-0 flex-1 truncate text-center text-[14.5px] font-semibold">{accountLabel ?? 'مُضاعِف'}</p>
          <NewChatButton iconOnly />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>

      {open && <div className="fixed inset-0 z-40 bg-foreground/30 lg:hidden" aria-hidden onClick={() => setOpen(false)} />}
      <div
        ref={panelRef}
        id="simple-menu"
        role="dialog"
        aria-modal="true"
        aria-label="القائمة"
        className={cn(
          'fixed inset-y-0 start-0 z-50 flex w-[min(300px,86vw)] flex-col bg-background shadow-[0_0_40px_rgba(14,20,38,0.18)] transition-transform duration-200 ease-out lg:hidden',
          open ? 'translate-x-0' : 'invisible rtl:translate-x-full ltr:-translate-x-full'
        )}
      >
        {sidebar(() => setOpen(false))}
      </div>
    </div>
  );
}

function NewChatButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const router = useRouter();
  // A fresh token every press: even on /home this opens a clean conversation.
  const start = () => router.push(`/home?new=${Date.now().toString(36)}`);
  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={start}
        aria-label="محادثة جديدة"
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-foreground hover:bg-foreground/[0.06]"
      >
        <SquarePen className="h-5 w-5" />
      </button>
    );
  }
  return (
    <button type="button" onClick={start} className={cn(ROW, ROW_IDLE, 'font-semibold')}>
      <SquarePen className="h-[18px] w-[18px]" />
      محادثة جديدة
    </button>
  );
}

function Sidebar({
  brandName,
  userEmail,
  accounts,
  revokedAccounts,
  pausedAccounts,
  selectedCustomerId,
  accountLabel,
  items,
  pathname,
  activeChat,
  recentChats,
  onClose,
  closeRef,
}: {
  brandName: string;
  userEmail: string;
  accounts: AdsAccountSummary[];
  revokedAccounts: AdsAccountSummary[];
  pausedAccounts: AdsAccountSummary[];
  selectedCustomerId: string | null;
  accountLabel: string | null;
  items: Item[];
  pathname: string;
  activeChat: string | null;
  recentChats: RecentChat[];
  onClose?: () => void;
  closeRef?: React.RefObject<HTMLButtonElement>;
}) {
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const initial = (brandName || userEmail || 'م').trim().charAt(0);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 flex-shrink-0 items-center justify-between gap-2 px-2">
        <Link href="/home" className="flex min-h-10 items-center gap-2 rounded-[10px] px-2 hover:bg-foreground/[0.06]" aria-label="الرئيسية">
          <LogoMark size={22} alt="" />
          <span className="text-[15.5px] font-bold">مُضاعِف</span>
        </Link>
        {onClose && (
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="سكّر القائمة"
            className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-foreground/[0.06]"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav className="flex-shrink-0 space-y-0.5 px-2" aria-label="الأقسام">
        <NewChatButton />
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
            >
              <Icon className="h-[18px] w-[18px] text-muted-foreground" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        <p className="px-3 pb-1.5 text-[12px] font-semibold text-muted-foreground">محادثاتك</p>
        {recentChats.length === 0 ? (
          <p className="px-3 text-[12.5px] leading-6 text-muted-foreground">أول ما تكلم مُضاعِف تطلع محادثاتك هنا.</p>
        ) : (
          <ul className="space-y-0.5">
            {recentChats.map((chat) => (
              <li key={chat.id}>
                <Link
                  href={`/home?c=${chat.id}`}
                  aria-current={activeChat === chat.id ? 'page' : undefined}
                  className={cn(ROW, 'min-h-9 text-[13.5px]', activeChat === chat.id ? ROW_ACTIVE : ROW_IDLE)}
                >
                  <span className="truncate">{chat.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-shrink-0 space-y-1 border-t border-border/60 p-2">
        <details className="group">
          <summary className={cn(ROW, ROW_IDLE, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-[12px] font-bold text-background">
              {initial}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13.5px] font-semibold">{accountLabel ?? 'الحساب الإعلاني'}</span>
              <span className="block truncate text-[11.5px] text-muted-foreground" dir="ltr">
                {userEmail}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="-mx-2 pb-2">
            <AccountSwitcher
              accounts={accounts}
              revokedAccounts={revokedAccounts}
              pausedAccounts={pausedAccounts}
              selectedCustomerId={selectedCustomerId}
            />
          </div>
        </details>
        <a
          href={`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(ROW, ROW_IDLE)}
        >
          <MessageCircle className="h-[18px] w-[18px] text-muted-foreground" />
          كلّم فريقنا على الواتساب
        </a>
        <div className="flex items-center gap-1">
          <form action="/api/auth/signout" method="post" className="min-w-0 flex-1">
            <button type="submit" className={cn(ROW, ROW_IDLE, 'text-muted-foreground')}>
              <LogOut className="h-[18px] w-[18px]" />
              تسجيل الخروج
            </button>
          </form>
          <ThemeToggle className="h-10 w-10 flex-shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  );
}
