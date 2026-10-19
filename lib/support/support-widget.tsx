'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, Send, X } from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import { supportBotHandoffUrl } from '@/lib/support/contact';
import { cn } from '@/lib/utils';

/**
 * The customer-service bot's window. Three layers, cheapest first:
 * 1. Buttons for the questions people ask most. The answers are fixed text
 *    from /faq and cost nothing.
 * 2. Free text goes to /api/support/chat (a small model reading the same FAQ).
 * 3. When the bot cannot finish, the same window offers WhatsApp with a
 *    prefilled summary. WhatsApp is never shown before that, except under the
 *    two FAQ answers that send people to the team on purpose.
 */

export type QuickQuestion = {
  id: string;
  q: string;
  a: string;
  link: { label: string; href: string } | null;
  /** Ready-made WhatsApp link for the two FAQ answers that end with the team. */
  whatsappUrl: string | null;
};

type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  link?: { label: string; href: string } | null;
  whatsappUrl?: string | null;
  assistantUrl?: string | null;
};

const MAX_USER_MESSAGES = 12;
const MAX_CHARS = 500;

const GREETING = 'هلا فيك. اختر سؤالك من تحت أو اكتبه بكلامك. وإذا ما قدرت أجاوبك أحوّلك لفريق مُضاعفة.';
const ERROR_TEXT = 'تعذّر الرد الحين. اضغط الزر تحت وكلّم فريق مُضاعفة على الواتساب.';
const LIMIT_TEXT = 'وصلت حد الرسائل مع الدعم الآلي. كمّل مع فريق مُضاعفة على الواتساب.';

export function SupportWidget({ quick }: { quick: QuickQuestion[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState<string[]>([]);
  const [typed, setTyped] = useState(false);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const userCount = messages.filter((m) => m.role === 'user').length;
  const atLimit = userCount >= MAX_USER_MESSAGES;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Before anything is said, keep the greeting in view; afterwards follow the conversation.
    el.scrollTop = messages.length === 0 && !loading ? 0 : el.scrollHeight;
  }, [messages, loading, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function push(message: Omit<Message, 'id'>) {
    const id = nextId.current++;
    setMessages((current) => [...current, { ...message, id }]);
  }

  function askQuick(item: QuickQuestion) {
    if (loading) return;
    setAsked((current) => [...current, item.id]);
    push({ role: 'user', text: item.q });
    push({ role: 'assistant', text: item.a, link: item.link, whatsappUrl: item.whatsappUrl });
  }

  async function send(text: string) {
    const clean = text.trim().slice(0, MAX_CHARS);
    if (!clean || loading) return;
    const history = [...messages, { role: 'user' as const, text: clean }].map((m) => ({
      role: m.role,
      content: m.text,
    }));
    push({ role: 'user', text: clean });
    setTyped(true);
    setDraft('');
    if (userCount + 1 > MAX_USER_MESSAGES) {
      push({ role: 'assistant', text: LIMIT_TEXT, whatsappUrl: supportBotHandoffUrl({ summary: clean }) });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/support/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, page: pathname }),
      });
      const data = (await res.json().catch(() => null)) as {
        answer?: string;
        link?: { label: string; href: string } | null;
        whatsappUrl?: string | null;
        assistantUrl?: string | null;
        error?: string;
      } | null;
      if (res.ok && data?.answer) {
        push({
          role: 'assistant',
          text: data.answer,
          link: data.link ?? null,
          whatsappUrl: data.whatsappUrl ?? null,
          assistantUrl: data.assistantUrl ?? null,
        });
      } else {
        push({
          role: 'assistant',
          text: data?.error === 'too_many_requests' ? LIMIT_TEXT : ERROR_TEXT,
          whatsappUrl: data?.whatsappUrl ?? supportBotHandoffUrl({ summary: clean }),
        });
      }
    } catch {
      push({ role: 'assistant', text: ERROR_TEXT, whatsappUrl: supportBotHandoffUrl({ summary: clean }) });
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  return (
    <div className="fixed bottom-4 end-4 z-50 flex flex-col items-end gap-3 print:hidden">
      {open ? (
        <section
          id="support-widget-panel"
          role="dialog"
          aria-label="الدعم"
          className="flex h-[min(34rem,calc(100dvh-6rem))] w-[min(23rem,calc(100vw-2rem))] flex-col border border-border-strong bg-card text-foreground shadow-pop"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-[15px] font-bold">الدعم</h2>
              <p className="mt-0.5 text-[12.5px] leading-5 text-muted-foreground">
                رد آلي من أسئلة العملاء المتكررة، ويحوّلك لفريق مُضاعفة إذا ما كفى.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                launcherRef.current?.focus();
              }}
              className={buttonClasses({ variant: 'ghost', size: 'icon' })}
              aria-label="إغلاق"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div ref={logRef} role="log" aria-live="polite" className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
            <Bubble role="assistant">{GREETING}</Bubble>

            {messages.map((m) => (
              <Bubble key={m.id} role={m.role}>
                {m.text}
                {m.role === 'assistant' && (m.link || m.assistantUrl || m.whatsappUrl) ? (
                  <span className="mt-3 flex flex-col items-stretch gap-2">
                    {m.link ? (
                      <Link href={m.link.href} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                        {m.link.label}
                      </Link>
                    ) : null}
                    {m.assistantUrl ? (
                      <Link href={m.assistantUrl} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                        افتح مساعد مُضاعِف
                      </Link>
                    ) : null}
                    {m.whatsappUrl ? (
                      <a
                        href={m.whatsappUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClasses({ variant: 'primary', size: 'md' })}
                      >
                        <MessageCircle className="h-4 w-4" aria-hidden />
                        كلّم فريق مُضاعفة على الواتساب
                      </a>
                    ) : null}
                  </span>
                ) : null}
              </Bubble>
            ))}

            {!typed && !loading && quick.some((item) => !asked.includes(item.id)) ? (
              <div className="flex flex-col gap-2" aria-label="أسئلة شائعة">
                {quick
                  .filter((item) => !asked.includes(item.id))
                  .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => askQuick(item)}
                    className="min-h-10 border border-border px-3 py-2 text-start text-[13.5px] leading-6 transition-colors hover:border-border-strong hover:bg-surface"
                  >
                    {item.q}
                  </button>
                ))}
                <Link href="/faq" className="px-1 text-[13px] font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground">
                  كل الأسئلة
                </Link>
              </div>
            ) : null}

            {loading ? (
              <p className="text-[13px] text-muted-foreground" role="status">
                الدعم يكتب...
              </p>
            ) : null}
          </div>

          <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-border p-3">
            <label className="sr-only" htmlFor="support-widget-input">
              اكتب سؤالك
            </label>
            <input
              id="support-widget-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_CHARS}
              placeholder={atLimit ? 'وصلت حد الرسائل' : 'اكتب سؤالك'}
              disabled={loading || atLimit}
              autoComplete="off"
              enterKeyHint="send"
              className="h-10 min-w-0 flex-1 border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={loading || atLimit || draft.trim().length === 0}
              className={buttonClasses({ variant: 'primary', size: 'icon' })}
              aria-label="إرسال"
            >
              <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
            </button>
          </form>
        </section>
      ) : null}

      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="support-widget-panel"
        className={cn(buttonClasses({ variant: 'primary', size: 'lg' }), 'shadow-pop')}
      >
        <MessageCircle className="h-5 w-5" aria-hidden />
        الدعم
      </button>
    </div>
  );
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'max-w-[88%] whitespace-pre-line px-3.5 py-2.5 text-[14px] leading-7',
        role === 'user'
          ? 'self-end bg-primary text-primary-foreground'
          : 'self-start border border-border bg-surface text-foreground'
      )}
    >
      {children}
    </div>
  );
}
