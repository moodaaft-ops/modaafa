'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Ellipsis, LoaderCircle, Pencil, Search, Trash2, X } from 'lucide-react';
import type { RecentChat } from '@/lib/chat-first/sessions';
import { CHAT_SEARCH_FROM, CHAT_TITLE_MAX, filterChatsByTitle } from '@/lib/chat-first/session-manage';
import { cn } from '@/lib/utils';

const MENU_ITEM =
  'flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-start text-[14px] transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]';

/** Room a popover needs below its button before it opens upward instead. */
const POPOVER_ROOM = 150;

type Mode = 'idle' | 'menu' | 'confirm' | 'rename';

/**
 * The «محادثاتك» part of the sidebar: past conversations, newest first, each
 * with a «⋯» menu to rename or delete it, and a search box once the list is
 * long. A rename or delete is a call to `/api/chat/sessions/[id]`, then the
 * server parts of the page are refreshed so every copy of the sidebar (the
 * desktop one and the phone drawer) shows the same list.
 */
export function RecentChats({ chats, activeChat }: { chats: RecentChat[]; activeChat: string | null }) {
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfterDelete = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  // What the server has not caught up with yet: new names and removed chats.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [gone, setGone] = useState<string[]>([]);

  // Once the refreshed list agrees with a local change, the change is dropped.
  useEffect(() => {
    setTitles((previous) => {
      const next: Record<string, string> = {};
      for (const chat of chats) {
        if (previous[chat.id] !== undefined && previous[chat.id] !== chat.title) next[chat.id] = previous[chat.id];
      }
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
    setGone((previous) => {
      const next = previous.filter((id) => chats.some((chat) => chat.id === id));
      return next.length === previous.length ? previous : next;
    });
  }, [chats]);

  const items = chats
    .filter((chat) => !gone.includes(chat.id))
    .map((chat) => ({ id: chat.id, title: titles[chat.id] ?? chat.title }));
  const showSearch = items.length > CHAT_SEARCH_FROM;
  const searching = showSearch && query.trim().length > 0;
  const shown = searching ? filterChatsByTitle(items, query) : items;

  // After a delete, keyboard focus moves to the neighbouring chat instead of falling to the page.
  useEffect(() => {
    const id = focusAfterDelete.current;
    if (id === null) return;
    focusAfterDelete.current = null;
    const target = id
      ? listRef.current?.querySelector<HTMLElement>(`[data-chat-id="${id}"] a`)
      : listRef.current?.parentElement?.querySelector<HTMLElement>('input');
    target?.focus();
  }, [gone]);

  function renamed(id: string, title: string) {
    setTitles((previous) => ({ ...previous, [id]: title }));
    router.refresh();
  }

  function deleted(id: string) {
    const index = shown.findIndex((chat) => chat.id === id);
    if (activeChat !== id) focusAfterDelete.current = (shown[index + 1] ?? shown[index - 1])?.id ?? '';
    setGone((previous) => (previous.includes(id) ? previous : [...previous, id]));
    // The chat on screen is gone: land on a fresh one instead of an empty thread.
    if (activeChat === id) router.replace('/home?new=1');
    router.refresh();
  }

  return (
    <div className="mt-5 flex min-h-0 flex-1 flex-col">
      {showSearch && (
        <label className="mx-2 mb-2 flex h-9 flex-shrink-0 items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3 focus-within:border-foreground/40">
          <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="دوّر في محادثاتك"
            aria-label="دوّر في محادثاتك"
            autoComplete="off"
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="امسح البحث"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      )}

      <div ref={listRef} data-chats-scroll className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        <p className="px-3 pb-1.5 text-[12px] font-semibold text-muted-foreground">محادثاتك</p>
        {items.length === 0 ? (
          <p className="px-3 text-[12.5px] leading-6 text-muted-foreground">أول ما تكلم مُضاعِف تطلع محادثاتك هنا.</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-2 text-[12.5px] leading-6 text-muted-foreground">ما لقيت محادثة بهالاسم.</p>
        ) : (
          <ul className="space-y-0.5">
            {shown.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={activeChat === chat.id}
                onRenamed={renamed}
                onDeleted={deleted}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  onRenamed,
  onDeleted,
}: {
  chat: RecentChat;
  active: boolean;
  onRenamed: (id: string, title: string) => void;
  onDeleted: (id: string) => void;
}) {
  const confirmTextId = useId();
  const rootRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const returnFocus = useRef(false);
  // Set once a rename has ended (saved or cancelled), so the input's blur is not read as a second save.
  const settled = useRef(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [placement, setPlacement] = useState<'down' | 'up'>('down');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const popoverOpen = mode === 'menu' || mode === 'confirm';

  function working(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }

  function closePopover(refocus: boolean) {
    returnFocus.current = refocus;
    setError('');
    setMode('idle');
  }

  useEffect(() => {
    if (!popoverOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (busyRef.current) return;
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closePopover(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Captured, so the phone drawer's own Escape handler does not close the whole menu too.
      event.stopPropagation();
      if (busyRef.current) return;
      closePopover(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [popoverOpen]);

  useEffect(() => {
    if (mode === 'menu') popoverRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    else if (mode === 'confirm') popoverRef.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
    else if (mode === 'rename') {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [mode]);

  function openMenu() {
    const trigger = triggerRef.current;
    const scroller = trigger?.closest('[data-chats-scroll]');
    if (trigger && scroller) {
      const button = trigger.getBoundingClientRect();
      const area = scroller.getBoundingClientRect();
      const below = area.bottom - button.bottom;
      const above = button.top - area.top;
      setPlacement(below < POPOVER_ROOM && above > below ? 'up' : 'down');
    }
    setError('');
    setMode('menu');
  }

  function onMenuKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Tab') {
      closePopover(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const entries = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (entries.length === 0) return;
    event.preventDefault();
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? entries.length - 1
          : event.key === 'ArrowDown'
            ? (at + 1) % entries.length
            : (at - 1 + entries.length) % entries.length;
    entries[next]?.focus();
  }

  function startRename() {
    settled.current = false;
    setDraft(chat.title);
    setError('');
    setMode('rename');
  }

  function endRename() {
    settled.current = true;
    returnFocus.current = true;
    working(false);
    setError('');
    setMode('idle');
  }

  async function saveRename() {
    if (busyRef.current || settled.current) return;
    const next = draft.replace(/\s+/g, ' ').trim();
    if (!next || next === chat.title) {
      endRename();
      return;
    }
    working(true);
    setError('');
    try {
      const response = await fetch(`/api/chat/sessions/${chat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!response.ok) throw new Error('rename_failed');
      const data = await response.json().catch(() => null);
      onRenamed(chat.id, typeof data?.title === 'string' && data.title ? data.title : next);
      endRename();
    } catch {
      working(false);
      setError('ما قدرت أحفظ الاسم. جرّب مرة ثانية.');
      inputRef.current?.focus();
    }
  }

  async function confirmDelete() {
    if (busyRef.current) return;
    working(true);
    setError('');
    try {
      const response = await fetch(`/api/chat/sessions/${chat.id}`, { method: 'DELETE' });
      // 404: it was already gone (deleted in another tab), which is what was asked for.
      if (!response.ok && response.status !== 404) throw new Error('delete_failed');
      onDeleted(chat.id);
    } catch {
      working(false);
      setError('ما قدرت أحذف المحادثة. جرّب مرة ثانية.');
    }
  }

  if (mode === 'rename') {
    return (
      <li data-chat-id={chat.id} className="px-0.5 py-0.5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
          className="relative"
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (!busyRef.current) endRename();
              }
            }}
            onBlur={() => {
              // Leaving the box saves what was typed; after a failed save it just gives up.
              if (error) {
                if (!busyRef.current) endRename();
              } else {
                void saveRename();
              }
            }}
            readOnly={busy}
            maxLength={CHAT_TITLE_MAX}
            aria-label="اسم المحادثة"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${confirmTextId}-error` : undefined}
            autoComplete="off"
            enterKeyHint="done"
            className={cn(
              'h-9 w-full rounded-full border bg-background px-3 text-[13.5px]',
              busy && 'pe-9 text-muted-foreground',
              error ? 'border-danger' : 'border-border'
            )}
          />
          {busy && (
            <LoaderCircle className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </form>
        {error && (
          <p id={`${confirmTextId}-error`} role="alert" className="px-3 pt-1 text-[12px] font-semibold text-danger">
            {error}
          </p>
        )}
      </li>
    );
  }

  return (
    <li
      ref={rootRef}
      data-chat-id={chat.id}
      className={cn(
        'group relative flex items-center rounded-[10px] transition-colors',
        active ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.06]',
        popoverOpen && !active && 'bg-foreground/[0.06]'
      )}
    >
      <Link
        href={`/home?c=${chat.id}`}
        title={chat.title}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-h-9 min-w-0 flex-1 items-center rounded-[10px] ps-3 pe-1 text-start text-[13.5px]',
          active && 'font-semibold'
        )}
      >
        <span className="truncate">{chat.title}</span>
      </Link>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (busyRef.current) return;
          if (popoverOpen) closePopover(true);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !popoverOpen) {
            event.preventDefault();
            openMenu();
          }
        }}
        aria-label="خيارات المحادثة"
        aria-haspopup="menu"
        aria-expanded={popoverOpen}
        className={cn(
          'me-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:bg-foreground/[0.08] hover:text-foreground',
          // Hover or focus on a computer; always there, and a bigger tap target, on a touch screen, which has no hover.
          'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:h-9 [@media(hover:none)]:w-9 [@media(hover:none)]:opacity-100',
          popoverOpen && 'bg-foreground/[0.08] opacity-100'
        )}
      >
        <Ellipsis className="h-4 w-4" />
      </button>

      {popoverOpen && (
        <div
          ref={popoverRef}
          className={cn(
            'absolute end-1 z-30 rounded-[16px] border border-border bg-background p-1.5 shadow-[0_18px_44px_-14px_rgba(14,20,38,0.4)] motion-safe:animate-fade-in-fast',
            mode === 'menu' ? 'w-[176px]' : 'w-[224px]',
            placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          )}
        >
          {mode === 'menu' ? (
            <div role="menu" aria-label="خيارات المحادثة" onKeyDown={onMenuKeyDown}>
              <button type="button" role="menuitem" onClick={startRename} className={MENU_ITEM}>
                <Pencil className="h-[17px] w-[17px] text-muted-foreground" />
                إعادة تسمية
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setError('');
                  setMode('confirm');
                }}
                className={cn(MENU_ITEM, 'text-danger')}
              >
                <Trash2 className="h-[17px] w-[17px]" />
                حذف
              </button>
            </div>
          ) : (
            <div role="alertdialog" aria-labelledby={confirmTextId} className="px-1.5 pb-0.5 pt-1.5">
              <p id={confirmTextId} className="pb-2.5 text-[13.5px] leading-6">
                تحذف المحادثة؟ ما تقدر ترجعها.
              </p>
              {error && (
                <p role="alert" className="pb-2 text-[12px] font-semibold text-danger">
                  {error}
                </p>
              )}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void confirmDelete()}
                  disabled={busy}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full border border-danger/40 bg-danger-soft text-[13.5px] font-semibold text-danger disabled:cursor-wait disabled:opacity-70"
                >
                  {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
                  حذف
                </button>
                <button
                  type="button"
                  data-cancel
                  onClick={() => closePopover(true)}
                  disabled={busy}
                  className="flex h-9 flex-1 items-center justify-center rounded-full border border-border text-[13.5px] hover:bg-foreground/[0.06] disabled:opacity-70"
                >
                  إلغاء
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
