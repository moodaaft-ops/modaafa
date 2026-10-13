'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowUp, AudioLines, RotateCcw, Square } from 'lucide-react';
import { ASSISTANT } from '@/lib/assistant/persona';
import { AssistantAvatar, TypingSquares } from '@/lib/ui/assistant-avatar';
import { cn, formatCurrency } from '@/lib/utils';
import { VoiceCallPanel, type VoiceCallHandle, type VoiceTurnResult } from '../assistant/voice-call-panel';
import type { ChatAction, ChatCard, ChatQuickAction, ChatTurn } from '@/lib/chat-first/contracts';

type Item =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string; cards: ChatCard[]; actions: ChatQuickAction[] };

const SEVERITY: Record<string, string> = { critical: 'عاجلة', medium: 'مهمة', growth: 'فرصة نمو' };

const NOTICE: Record<string, string> = {
  executed: 'تم تنفيذ التغيير على حسابك.',
  approved: 'سجلنا موافقتك. اضغط «نفّذ الحين» لما تكون جاهز.',
  'error:subscription_required': 'التنفيذ يحتاج اشتراك فعّال. فعّله وارجع لنفس التوصية.',
  'error:manual_review_required': 'هذي التوصية تحتاج مراجعتك اليدوية من لوحة التفاصيل.',
  'error:approve_before_execution': 'لازم توافق على التغيير قبل التنفيذ.',
  'error:blocked_by_guardrails': 'حمايات الحساب أوقفت هذا التغيير عشان ما يضرك.',
  updated: 'تمام، شلته من القائمة.',
  reverted: 'رجّعت التغيير مثل ما كان.',
  'error:rollback_unavailable': 'التراجع ما عاد متاح لهذا التغيير (مر عليه أكثر من 30 يوم أو انرجع قبل).',
  'error:rollback_failed': 'قوقل رفض التراجع وما تغيّر شي. اسألني وأشوف السبب.',
  'error:recommendation_locked': 'هذا الاقتراح انطبق أو انشال قبل.',
  'error:execution_failed': 'قوقل رفض التغيير وما تغيّر شي في حسابك. اسألني وأشوف السبب.',
  'error:already_executing': 'التغيير قاعد يتنفذ الحين.',
};

let counter = 0;
const uid = () => `m${Date.now()}-${counter++}`;

/** Where the approve, dismiss and undo forms send the customer back to. */
const ReturnPathContext = createContext('/start');

/** The selected account's currency, for cards saved before they carried their own. */
const AccountCurrencyContext = createContext<string | null>(null);

/**
 * Other parts of the home screen ask «مُضاعِف» something by dispatching this
 * event (a decision card's «اسأل مُضاعِف عنها»). The chat sends it as if typed.
 */
export const ASK_ASSISTANT_EVENT = 'assistant:ask';
export type AskAssistantDetail = { text: string; label?: string; recommendationId?: string };

export function StartClient(props: React.ComponentProps<typeof StartClientBody>) {
  return (
    <AccountCurrencyContext.Provider value={props.currency ?? null}>
      <StartClientBody {...props} />
    </AccountCurrencyContext.Provider>
  );
}

function StartClientBody({
  customerId,
  notice,
  voiceEnabled = false,
  returnPath = '/start',
  variant = 'page',
  fresh = false,
  restoreSessionId = null,
  intro = null,
  introActions,
  onSessionStarted,
}: {
  customerId: string | null;
  notice: string | null;
  voiceEnabled?: boolean;
  /** The page the approval forms return to. */
  returnPath?: string;
  /** 'thread' fills its container edge to edge, like ChatGPT's conversation. */
  variant?: 'page' | 'thread';
  /** Start a new conversation instead of reopening the latest one. */
  fresh?: boolean;
  /** Reopen this conversation (the sidebar's list). */
  restoreSessionId?: string | null;
  /** Server-rendered opening message from «مُضاعِف» (the day's briefing). */
  intro?: React.ReactNode;
  /** Suggestions under the opening message until the customer writes. */
  introActions?: ChatQuickAction[];
  /** Called once when the first message of a new conversation is saved. */
  onSessionStarted?: (sessionId: string) => void;
  /** Currency of the selected Google Ads account (amounts in old saved cards use it). */
  currency?: string | null;
}) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceRef = useRef<VoiceCallHandle>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'chat' | 'audit'>(null);
  const [failed, setFailed] = useState<null | (() => void)>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onSessionStartedRef = useRef(onSessionStarted);
  onSessionStartedRef.current = onSessionStarted;

  const push = useCallback((i: Item) => setItems((cur) => [...cur, i]), []);
  const assistant = useCallback(
    (reply: string, cards: ChatCard[] = [], actions: ChatQuickAction[] = []) =>
      push({ id: uid(), role: 'assistant', text: reply, cards, actions }),
    [push]
  );

  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an
  // effect that returns it hands React a non-function cleanup, which crashes the page.
  // A fresh home opens on the briefing: start at its top, follow the bottom
  // only once the conversation actually moves.
  useEffect(() => {
    if (items.length === 0 && !busy) return;
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [items, busy]);

  // Restore this account's own history; the API filters by owner AND account.
  // Switching account starts a fresh session: never carry A's sessionId, items
  // or pending retry over to B.
  useEffect(() => {
    let live = true;
    abortRef.current?.abort();
    setSessionId(null);
    setItems([]);
    setFailed(null);
    setBusy(null);
    const greeting: Item = {
      id: uid(),
      role: 'assistant',
      text: `هلا، أنا ${ASSISTANT.name}. اسألني عن إعلاناتك بكلامك العادي، وأقرأ حسابك وأجاوبك.`,
      cards: [],
      actions: quickStart(),
    };
    if (fresh) {
      // A new conversation: the opening message (if any) is the server's intro.
      setItems(intro ? [] : [greeting]);
      return () => {
        live = false;
      };
    }
    (async () => {
      try {
        const params = new URLSearchParams();
        if (customerId) params.set('customerId', customerId);
        if (restoreSessionId) params.set('sessionId', restoreSessionId);
        const qs = params.toString() ? `?${params.toString()}` : '';
        const res = await fetch(`/api/chat/start${qs}`, { cache: 'no-store' });
        if (!res.ok) {
          if (live) {
            setItems(
              restoreSessionId
                ? [{ id: uid(), role: 'assistant', text: 'ما لقيت هالمحادثة. ابدأ وحدة جديدة من القائمة.', cards: [], actions: [] }]
                : [greeting]
            );
          }
          return;
        }
        const data = await res.json();
        if (!live) return;
        if (data.sessionId) setSessionId(data.sessionId);
        const restored: Item[] = (data.messages ?? [])
          .filter((m: any) => m.role === 'user' || m.role === 'assistant')
          .map((m: any) =>
            m.role === 'user'
              ? { id: uid(), role: 'user' as const, text: m.content ?? '' }
              : {
                  id: uid(),
                  role: 'assistant' as const,
                  text: m.content ?? '',
                  // Restored cards are read-only history; buttons only live on the newest turn.
                  cards: m.tool_results?.cards ?? [],
                  actions: [],
                }
          );
        const n = notice ? NOTICE[notice] : null;
        setItems([
          ...restored,
          ...(restored.length === 0 ? [greeting] : []),
          ...(n ? [{ id: uid(), role: 'assistant' as const, text: n, cards: [], actions: [] }] : []),
        ]);
      } catch {
        setItems([{ id: uid(), role: 'assistant', text: `هلا، أنا ${ASSISTANT.name}. وش تبي نشوف؟`, cards: [], actions: quickStart() }]);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, fresh, restoreSessionId]);

  async function send(body: Record<string, unknown>, shown: string, voiceTicket?: string): Promise<VoiceTurnResult> {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setFailed(null);
    setBusy('chat');
    if (shown) push({ id: uid(), role: 'user', text: shown });
    try {
      const res = await fetch('/api/chat/start', {
        method: 'POST',
        headers: voiceTicket
          ? { 'content-type': 'application/json', 'x-voice-ticket': voiceTicket }
          : { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, sessionId, customerId }),
        signal: ac.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404 && data.error === 'session_not_found') {
        // The session belongs to another account (or is gone): start clean.
        setSessionId(null);
        assistant('بدأت لك محادثة جديدة لهذا الحساب. أعد سؤالك.');
        return null;
      }
      if (voiceTicket && res.status === 409 && data.error === 'account_changed') {
        assistant('تغيّر الحساب أثناء المكالمة، فانتهت. ابدأ مكالمة جديدة على الحساب الحالي.');
        return { reply: '', hasDraft: false, fatal: 'account_changed' };
      }
      if (voiceTicket && res.status === 401 && data.error === 'session_ended') {
        assistant('انتهت المكالمة. ابدأ مكالمة جديدة لو تبي تكمل صوتياً.');
        return { reply: '', hasDraft: false, fatal: 'session_ended' };
      }
      if (!res.ok) {
        const msg =
          res.status === 404
            ? 'ما لقيت هذا الحساب أو هذي التوصية ضمن حسابك.'
            : res.status === 429
              ? 'كثّرت علي شوي. جرب بعد دقيقة.'
              : res.status === 401
                ? 'انتهت جلستك، سجل دخولك من جديد.'
                : 'صار خلل عندنا. جرب مرة ثانية.';
        assistant(msg);
        // A spoken turn is not retried from here: its ticket works once.
        if (!voiceTicket) setFailed(() => () => send(body, ''));
        return null;
      }
      if (data.sessionId) {
        if (!sessionId) onSessionStartedRef.current?.(data.sessionId);
        setSessionId(data.sessionId);
      }
      const turn = data.turn as ChatTurn;
      assistant(turn.reply, turn.cards, turn.actions);
      if (data.saved === false) assistant('ملاحظة: ما قدرت أحفظ هذي المحادثة في السجل.');
      return {
        reply: turn.reply,
        hasDraft: false,
        speech:
          data.voice?.speak_ticket && data.voice?.spoken_text
            ? { spokenText: String(data.voice.spoken_text), speakTicket: String(data.voice.speak_ticket) }
            : null,
      };
    } catch (e: any) {
      if (e?.name === 'AbortError') assistant('أوقفت الانتظار.');
      else {
        assistant('انقطع الاتصال. تقدر تعيد المحاولة.');
        if (!voiceTicket) setFailed(() => () => send(body, ''));
      }
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runAudit(targetCustomerId: string) {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setFailed(null);
    setBusy('audit');
    push({ id: uid(), role: 'user', text: 'ابدأ الفحص' });
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: targetCustomerId }),
        signal: ac.signal,
      });
      const data = await res.json().catch(() => ({}));
      // PR #57 contract (docs/free-audit-contract.md): the code, not the
      // status alone, decides the wording.
      if (res.status === 402) {
        const exhausted =
          data.error === 'free_audits_exhausted' || data.error === 'free_accounts_exhausted';
        assistant(
          data.message ||
            (exhausted
              ? 'خلصت الفحوصات المجانية لهذا الحساب. تقدر تشوف نتيجة آخر فحص، وفعّل الاشتراك لو تبي فحص جديد.'
              : 'الفحص يحتاج اشتراك أو تجربة نشطة حالياً.'),
          [{ kind: 'subscription_required', reason: exhausted ? 'free_audits_exhausted' : 'subscription_required' }],
          [
            { label: 'فعّل الاشتراك', action: { type: 'subscribe', href: '/billing' } },
            ...(exhausted ? [{ label: 'وريني آخر نتيجة', action: { type: 'say' as const, text: 'وش وضع حسابي' } }] : []),
          ]
        );
        return;
      }
      if (res.status === 409) {
        assistant(data.message || 'فيه فحص شغال على هذا الحساب الحين. انتظر دقائق وأعرض لك النتيجة.', [], [
          { label: 'شيّك على النتيجة', action: { type: 'say', text: 'وش وضع حسابي' } },
        ]);
        return;
      }
      if (res.status === 429) {
        assistant(data.message || 'وصلت حد الاستخدام الحالي. جرب بعد ما يتجدد، وما انخصم منك شيء.');
        return;
      }
      if (res.status === 503) {
        assistant(data.message || 'تعذر نتحقق من رصيد الفحوصات الحين، فما بدأت الفحص عشان ما ينخصم منك شيء. جرب بعد دقيقة.');
        setFailed(() => () => runAudit(targetCustomerId));
        return;
      }
      if (!res.ok) {
        assistant(data.message || 'الفحص ما كمل. ما انخصم منك شيء، جرب مرة ثانية.');
        setFailed(() => () => runAudit(targetCustomerId));
        return;
      }
      if (data?.usage?.source === 'free' && typeof data.usage.remaining === 'number') {
        assistant(
          data.usage.remaining > 0
            ? `هذا فحص مجاني. باقي لك ${data.usage.remaining} لهذا الحساب.`
            : 'هذا آخر فحص مجاني لهذا الحساب.'
        );
      }
      assistant('خلص الفحص. أعرض لك النتيجة:');
      await send({ message: 'وش وضع حسابي' }, '');
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        assistant('أوقفت الانتظار هنا. الفحص قد يكون كمّل عندنا، اسأل «وش وضع حسابي» وأشيك لك.');
      } else {
        assistant('انقطع الاتصال أثناء الفحص.');
        setFailed(() => () => runAudit(targetCustomerId));
      }
    } finally {
      setBusy(null);
    }
  }

  function onAction(a: ChatAction, label: string) {
    switch (a.type) {
      case 'run_audit':
        return runAudit(a.customerId);
      case 'say':
        return send({ message: a.text }, label);
      case 'show_recommendation':
        return send({ action: { type: 'show_recommendation', recommendationId: a.recommendationId } }, label);
      case 'request_apply':
        return send({ action: { type: 'request_apply', recommendationId: a.recommendationId } }, label);
      default:
        return;
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    if (inputRef.current) inputRef.current.style.height = '';
    send({ message: t }, t);
  }

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  /**
   * One tap opens the call: the bar is mounted synchronously so the mic, the
   * audio context and the silent unlock all happen inside this same tap, which
   * iOS Safari requires before it lets the reply play.
   */
  function openVoice() {
    if (!voiceOpen) flushSync(() => setVoiceOpen(true));
    voiceRef.current?.start();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line; never mid-composition (Arabic IMEs).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  // The voice panel outlives re-renders; it always calls the newest `send`.
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<AskAssistantDetail>).detail;
      if (!detail?.text) return;
      if (detail.recommendationId) {
        void sendRef.current(
          { action: { type: 'show_recommendation', recommendationId: detail.recommendationId } },
          detail.label ?? detail.text
        );
      } else {
        void sendRef.current({ message: detail.text }, detail.label ?? detail.text);
      }
    };
    window.addEventListener(ASK_ASSISTANT_EVENT, onAsk);
    return () => window.removeEventListener(ASK_ASSISTANT_EVENT, onAsk);
  }, []);

  const lastAssistant = [...items].reverse().find((i) => i.role === 'assistant')?.id;
  const showIntroActions = !!intro && items.length === 0 && (introActions ?? quickStart()).length > 0;

  return (
    <ReturnPathContext.Provider value={returnPath}>
    <div
      className={cn(
        'flex min-h-0 flex-col bg-background',
        variant === 'page' ? 'mx-auto h-[calc(100dvh-9rem)] w-full max-w-3xl' : 'h-full w-full'
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" aria-live="polite">
        <div className="mx-auto w-full max-w-[768px] space-y-7 px-4 pb-8 pt-6 sm:px-6 lg:pt-10">
          {intro && (
            <AssistantTurn avatar>
              {intro}
              {showIntroActions && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {(introActions ?? quickStart()).map((q, idx) => (
                    <ActionButton key={idx} q={q} disabled={!!busy} onAction={onAction} recId={recIdOf(q.action)} />
                  ))}
                </div>
              )}
            </AssistantTurn>
          )}
          {items.map((i, index) =>
            i.role === 'user' ? (
              <div key={i.id} className="flex justify-end">
                <p className="max-w-[82%] whitespace-pre-line rounded-[22px] bg-muted px-4 py-2.5 text-[15.5px] leading-7 text-foreground">
                  {i.text}
                </p>
              </div>
            ) : (
              <AssistantTurn key={i.id} avatar={(index === 0 && !intro) || items[index - 1]?.role !== 'assistant'}>
                {i.text && <p className="whitespace-pre-line">{i.text}</p>}
                {i.cards.map((c, idx) => (
                  <CardView key={idx} card={c} />
                ))}
                {i.id === lastAssistant && i.actions.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {i.actions.map((q, idx) => (
                      <ActionButton key={idx} q={q} disabled={!!busy} onAction={onAction} recId={recIdOf(q.action)} />
                    ))}
                  </div>
                )}
              </AssistantTurn>
            )
          )}
          {busy && (
            <AssistantTurn avatar thinking>
              <div className="flex flex-wrap items-center gap-2.5 text-[14px] text-muted-foreground">
                <TypingSquares />
                {busy === 'audit' ? 'أفحص حسابك، ياخذ دقائق قليلة…' : `${ASSISTANT.name} يقرأ…`}
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-[12.5px] text-foreground hover:bg-muted"
                >
                  <Square className="h-3 w-3" /> إلغاء
                </button>
              </div>
            </AssistantTurn>
          )}
          {failed && !busy && (
            <div className="ps-10">
              <button
                type="button"
                onClick={() => failed()}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-[13.5px] hover:bg-muted"
              >
                <RotateCcw className="h-3.5 w-3.5" /> أعد المحاولة
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[768px] flex-shrink-0 px-3 pb-3 sm:px-6 sm:pb-5">
        {memoryOpen && (
          <div className="mb-2 overflow-hidden rounded-[20px] border border-border bg-card">
            <MemoryPanel onClose={() => setMemoryOpen(false)} />
          </div>
        )}
        {voiceEnabled && voiceOpen ? (
          <VoiceCallPanel
            ref={voiceRef}
            customerId={customerId}
            onUtterance={(spoken, ticket) => sendRef.current({ message: spoken }, spoken, ticket)}
            onClose={() => setVoiceOpen(false)}
          />
        ) : (
        <form
          onSubmit={submit}
          className="flex items-end gap-1.5 rounded-[26px] border border-border bg-card p-2 ps-4 shadow-[0_8px_28px_-14px_rgba(14,20,38,0.35)] transition-colors focus-within:border-border-strong"
        >
          <textarea
            ref={inputRef}
            value={text}
            onChange={onInput}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={1000}
            placeholder={`اكتب لـ${ASSISTANT.name}…`}
            aria-label="رسالتك"
            className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent py-2 text-[16px] leading-7 text-foreground outline-none placeholder:text-muted-foreground"
          />
          {voiceEnabled && (
            <button
              type="button"
              onClick={openVoice}
              aria-label="مكالمة صوتية"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted"
            >
              <AudioLines className="h-[18px] w-[18px]" />
            </button>
          )}
          <button
            type="submit"
            disabled={!text.trim() || !!busy}
            aria-label="إرسال"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </form>
        )}
        {!voiceOpen && (
          <p className="mt-2 px-2 text-center text-[11.5px] leading-5 text-muted-foreground">
            ما يتغيّر شي في حسابك إلا باعتمادك.{' '}
            <button type="button" onClick={() => setMemoryOpen((open) => !open)} className="underline underline-offset-4 hover:text-foreground">
              وش يعرف {ASSISTANT.name} عن نشاطك
            </button>
          </p>
        )}
      </div>
    </div>
    </ReturnPathContext.Provider>
  );
}

/** One turn from «مُضاعِف»: the mark on the start side, plain text, no bubble. */
function AssistantTurn({
  avatar,
  thinking = false,
  children,
}: {
  avatar: boolean;
  thinking?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      {/* On a phone the reply takes the full width, like ChatGPT; the avatar shows from sm up. */}
      <div className="hidden w-7 flex-shrink-0 pt-1 sm:block">{avatar &&<AssistantAvatar size={28} thinking={thinking} />}</div>
      <div className="min-w-0 flex-1 space-y-3 text-[15.5px] leading-8 text-foreground">{children}</div>
    </div>
  );
}

function quickStart(): ChatQuickAction[] {
  return [
    { label: 'وش خطة اليوم؟', action: { type: 'say', text: 'وش أهم شي أسويه اليوم في إعلاناتي؟' } },
    { label: 'وين تروح فلوسي؟', action: { type: 'say', text: 'وين تروح فلوسي في الإعلانات؟' } },
    { label: 'ليش الطلبات قليلة؟', action: { type: 'say', text: 'ليش الطلبات قليلة؟' } },
    { label: 'وش وضع حسابي؟', action: { type: 'say', text: 'وش وضع حسابي' } },
  ];
}

function recIdOf(a: ChatAction) {
  return a.type === 'approve' || a.type === 'execute' || a.type === 'approve_execute' || a.type === 'dismiss'
    ? a.recommendationId
    : null;
}

function ActionButton({
  q,
  disabled,
  onAction,
  recId,
}: {
  q: ChatQuickAction;
  disabled: boolean;
  onAction: (a: ChatAction, label: string) => void;
  recId: string | null;
}) {
  const cls =
    'inline-flex min-h-9 items-center rounded-full border border-border bg-card px-4 text-[13.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50';
  const a = q.action;
  if (a.type === 'connect_account' || a.type === 'subscribe' || a.type === 'open_dashboard') {
    return (
      <Link href={a.href} className={cls}>
        {q.label}
      </Link>
    );
  }
  if ((a.type === 'approve' || a.type === 'execute' || a.type === 'approve_execute' || a.type === 'dismiss') && recId) {
    // Goes through the existing guarded route; it redirects back to /start.
    return <RecommendationForm recId={recId} intent={a.type} label={q.label} className={cls} disabled={disabled} />;
  }
  return (
    <button type="button" disabled={disabled} onClick={() => onAction(a, q.label)} className={cls}>
      {q.label}
    </button>
  );
}

/**
 * The ONLY way this screen reaches the approval route: a plain HTML form a
 * person taps. Voice turns never post here (tests/voice-server.test.ts).
 */
function RecommendationForm({
  recId,
  intent,
  label,
  className,
  disabled = false,
}: {
  recId: string;
  intent: 'approve' | 'execute' | 'approve_execute' | 'dismiss';
  label: string;
  className: string;
  disabled?: boolean;
}) {
  const returnPath = useContext(ReturnPathContext);
  return (
    <form method="post" action="/api/recommendations/action">
      <input type="hidden" name="recommendation_id" value={recId} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value={returnPath} />
      <button type="submit" disabled={disabled} className={className}>
        {label}
      </button>
    </form>
  );
}

function CardView({ card }: { card: ChatCard }) {
  const accountCurrency = useContext(AccountCurrencyContext);
  const box = 'w-full rounded-[18px] border border-border/80 bg-card p-4 text-[14px] leading-7';
  switch (card.kind) {
    case 'audit_result':
      return (
        <div className={box}>
          <p className="text-[11px] text-muted-foreground">آخر فحص</p>
          <p className="text-2xl font-bold">
            {card.healthScore ?? '؟'}
            <span className="text-sm font-normal text-muted-foreground"> / 100</span>
          </p>
          <p>{card.findingsCount} ملاحظة</p>
          {card.estimatedMonthlyWaste != null && (
            <p>
              هدر شهري تقديري:{' '}
              <span className="numeric">
                {formatCurrency(Math.round(card.estimatedMonthlyWaste), card.currency ?? accountCurrency)}
              </span>
            </p>
          )}
        </div>
      );
    case 'recommendation':
      return (
        <div className={box}>
          <p className="text-[11px] text-muted-foreground">
            {card.severity ? SEVERITY[card.severity] : 'توصية'} · معاينة فقط
          </p>
          <p className="font-semibold">{card.title}</p>
          {card.description && <p className="text-muted-foreground">{card.description}</p>}
        </div>
      );
    case 'approval':
      return (
        <div className={box}>
          <p className="text-[11px] text-muted-foreground">بيتغيّر في حسابك</p>
          <p className="font-semibold">{card.title}</p>
          {card.changes.map((c, i) => (
            <p key={i}>{c}</p>
          ))}
        </div>
      );
    case 'subscription_required':
      return (
        <div className={box}>
          <p className="font-semibold">التطبيق يحتاج اشتراك</p>
          <p className="text-muted-foreground">الفحص والمعاينة مجانيين، وأي تغيير على حسابك بعد الاشتراك وموافقتك.</p>
        </div>
      );
    case 'status':
      return (
        <div className={box}>
          <p className="font-semibold">{card.title}</p>
          {card.lines.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      );
    case 'proposal':
      return <ProposalCard card={card} />;
    case 'manual_steps':
      return (
        <div className={box}>
          <p className="text-[11px] text-muted-foreground">خطوات تسويها بنفسك</p>
          <p className="font-semibold">{card.title}</p>
          <ol className="list-decimal ps-5">
            {card.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      );
    case 'memory_saved':
      return <MemoryCard card={card} />;
    case 'consent':
      return <ConsentCard card={card} />;
  }
}

const OPEN_STATUSES = new Set(['pending', 'approved']);

function ProposalCard({ card }: { card: Extract<ChatCard, { kind: 'proposal' }> }) {
  const returnPath = useContext(ReturnPathContext);
  const live = !card.status || OPEN_STATUSES.has(card.status);
  const btn =
    'inline-flex h-9 items-center rounded-full border px-4 text-[13.5px] font-semibold disabled:opacity-50';
  return (
    <div id={`card-${card.recommendationId}`} className="w-full rounded-[18px] border border-border/80 bg-card p-4 text-[14px] leading-7">
      <p className="text-[11px] text-muted-foreground">
        {card.size === 'small' ? 'تعديل صغير' : 'يحتاج اعتمادك'}
        {card.status === 'applied' ? ' · انطبق' : card.status === 'dismissed' ? ' · انشال' : card.status === 'failed' ? ' · ما انطبق' : ''}
      </p>
      <p className="font-semibold">{card.title}</p>
      <p className="text-muted-foreground">{card.why}</p>
      <ul className="mt-1 list-disc ps-5">
        {card.changes.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      {card.warnings.map((w, i) => (
        <p key={i} className="mt-1 text-[12px] text-red-600 dark:text-red-400">
          {w}
        </p>
      ))}
      {card.evidence.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-muted-foreground">وش هي؟</summary>
          <table className="mt-1 w-full text-[12px]">
            <tbody>
              {card.evidence.map((e, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="py-1 pe-2 font-medium">{e.label}</td>
                  <td className="py-1 text-muted-foreground">{e.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {card.status === 'applied' && card.undoActionId && (
        <form method="post" action="/api/actions/rollback" className="mt-2">
          <input type="hidden" name="action_id" value={card.undoActionId} />
          <input type="hidden" name="next" value={returnPath} />
          <button type="submit" className={`${btn} border-border`}>
            تراجع عن التغيير
          </button>
        </form>
      )}
      {live && (
        <div className="mt-2 flex flex-wrap gap-2">
          {card.canApprove ? (
            <RecommendationForm
              recId={card.recommendationId}
              // An already approved row only needs the final step; approve_execute would be refused as locked.
              intent={card.status === 'approved' ? 'execute' : 'approve_execute'}
              label={card.status === 'approved' ? 'نفّذ الحين' : 'اعتمد'}
              className={`${btn} border-primary bg-primary text-primary-foreground`}
            />
          ) : (
            <Link href="/billing" className={`${btn} border-primary/30 bg-primary/[0.07]`}>
              فعّل الاشتراك عشان تعتمد
            </Link>
          )}
          <RecommendationForm recId={card.recommendationId} intent="dismiss" label="مو الحين" className={`${btn} border-border`} />
        </div>
      )}
    </div>
  );
}

function MemoryCard({ card }: { card: Extract<ChatCard, { kind: 'memory_saved' }> }) {
  const [state, setState] = useState<'saved' | 'deleting' | 'deleted' | 'failed'>('saved');
  async function remove() {
    setState('deleting');
    try {
      const res = await fetch('/api/jarvis/memory', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: card.factId }),
      });
      setState(res.ok ? 'deleted' : 'failed');
    } catch {
      setState('failed');
    }
  }
  return (
    <div className="w-full rounded-[18px] border border-border/80 bg-card p-4 text-[14px] leading-7">
      <p className="text-[11px] text-muted-foreground">حفظت عن نشاطك</p>
      <p className={state === 'deleted' ? 'line-through text-muted-foreground' : ''}>{card.fact}</p>
      {card.quote && <p className="text-[12px] text-muted-foreground">من كلامك: «{card.quote}»</p>}
      {state !== 'deleted' && (
        <button
          type="button"
          onClick={remove}
          disabled={state === 'deleting'}
          className="mt-1 text-[12px] text-muted-foreground underline disabled:opacity-50"
        >
          {state === 'failed' ? 'ما انحذفت، جرّب مرة ثانية' : 'احذفها'}
        </button>
      )}
    </div>
  );
}

function ConsentCard({ card }: { card: Extract<ChatCard, { kind: 'consent' }> }) {
  const [answer, setAnswer] = useState<null | 'auto_small' | 'always_ask' | 'saving' | 'failed'>(card.answered ?? null);
  async function choose(value: 'auto_small' | 'always_ask') {
    setAnswer('saving');
    try {
      const res = await fetch('/api/autopilot/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: card.accountCustomerId, answer: value, channel: 'chat' }),
      });
      setAnswer(res.ok ? value : 'failed');
    } catch {
      setAnswer('failed');
    }
  }
  const btn = 'border px-3.5 py-2 text-[13px] font-medium disabled:opacity-50';
  if (answer === 'auto_small' || answer === 'always_ask') {
    return (
      <div className="w-full rounded-[18px] border border-border/80 bg-card p-4 text-[14px] leading-7">
        {answer === 'auto_small'
          ? 'تمام. أول ما يفتح التنفيذ التلقائي في المنصة أشغّله لك على التعديلات الصغيرة بس، وللحين أجهز وأنت تعتمد.'
          : 'تمام، بستأذنك في كل تعديل.'}
      </div>
    );
  }
  return (
    <div className="w-full rounded-[18px] border border-border/80 bg-card p-4 text-[14px] leading-7">
      <p className="font-semibold">سؤال واحد قبل نكمل</p>
      <p>
        التعديلات الصغيرة، مثل إني أمنع إعلانك يطلع لعبارة بحث واضح إنها مو لك وصرفت بدون فايدة، تبيني أسويها لحالي
        وأبلغك؟ أي شي يلمس الميزانية أو يوقف حملة أو يغيّر المزايدة بستأذنك فيه دايماً، وكل شي أسويه تقدر تتراجع عنه خلال
        30 يوم.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={answer === 'saving'} onClick={() => choose('auto_small')} className={`${btn} border-primary bg-primary text-primary-foreground`}>
          سوّها وبلغني
        </button>
        <button type="button" disabled={answer === 'saving'} onClick={() => choose('always_ask')} className={`${btn} border-border`}>
          استأذني في كل شي
        </button>
      </div>
      {answer === 'failed' && <p className="mt-1 text-[12px] text-red-600">ما انحفظ اختيارك، جرّب مرة ثانية.</p>}
    </div>
  );
}

type MemoryRow = { id: string; kind: string; fact_ar: string; source: string; basis: string; created_at: string };

const MEMORY_SOURCE: Record<string, string> = {
  chat: 'من كلامك',
  voice: 'من كلامك بالصوت',
  onboarding: 'من التعريف',
  action_outcome: 'نتيجة تعديل مقاسة',
  weekly_review: 'ملاحظة أسبوعية',
  settings: 'من الإعدادات',
};

/** «وش أعرف عن نشاطك»: every saved fact with its source and a delete button (spec 83, 6.4). */
function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/jarvis/memory', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => live && setRows(Array.isArray(data.facts) ? data.facts : []))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  async function remove(id: string) {
    const res = await fetch('/api/jarvis/memory', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    if (res?.ok) setRows((cur) => (cur ?? []).filter((row) => row.id !== id));
  }
  return (
    <div className="max-h-64 overflow-y-auto px-4 py-3 text-[13.5px] leading-7">
      <div className="mb-1 flex items-center justify-between">
        <p className="font-semibold">وش يعرف {ASSISTANT.name} عن نشاطك</p>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground underline">
          سكّر
        </button>
      </div>
      {failed && <p className="text-muted-foreground">ما قدرت أفتح الذاكرة الحين.</p>}
      {!failed && rows === null && <p className="text-muted-foreground">ثواني…</p>}
      {rows?.length === 0 && (
        <p className="text-muted-foreground">ما حفظت شي للحين. قل لي مثلاً «رمضان أقوى موسم عندي» وأحفظها.</p>
      )}
      <ul className="space-y-1">
        {rows?.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-2 border-b border-border/50 pb-1">
            <span>
              {row.fact_ar}
              <span className="ms-1 text-[11px] text-muted-foreground">({MEMORY_SOURCE[row.source] ?? row.source})</span>
            </span>
            <button type="button" onClick={() => remove(row.id)} className="shrink-0 text-[12px] text-muted-foreground underline">
              احذف
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
