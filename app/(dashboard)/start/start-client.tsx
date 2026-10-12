'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Loader2, RotateCcw, Send, Square } from 'lucide-react';
import { VoiceCallPanel, type VoiceTurnResult } from '../assistant/voice-call-panel';
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

export function StartClient({
  customerId,
  notice,
  voiceEnabled = false,
}: {
  customerId: string | null;
  notice: string | null;
  voiceEnabled?: boolean;
}) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'chat' | 'audit'>(null);
  const [failed, setFailed] = useState<null | (() => void)>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const push = useCallback((i: Item) => setItems((cur) => [...cur, i]), []);
  const assistant = useCallback(
    (reply: string, cards: ChatCard[] = [], actions: ChatQuickAction[] = []) =>
      push({ id: uid(), role: 'assistant', text: reply, cards, actions }),
    [push]
  );

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), [items, busy]);

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
    (async () => {
      try {
        const qs = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
        const res = await fetch(`/api/chat/start${qs}`, { cache: 'no-store' });
        if (!res.ok) return;
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
          ...(restored.length === 0
            ? [{ id: uid(), role: 'assistant' as const, text: 'هلا فيك. أنا أساعدك في إعلاناتك بدون ما تحتاج تفهم مصطلحاتها. وش تبي؟', cards: [], actions: quickStart() }]
            : []),
          ...(n ? [{ id: uid(), role: 'assistant' as const, text: n, cards: [], actions: [] }] : []),
        ]);
      } catch {
        setItems([{ id: uid(), role: 'assistant', text: 'هلا فيك. وش تبي؟', cards: [], actions: quickStart() }]);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

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
      if (data.sessionId) setSessionId(data.sessionId);
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
        const exhausted = data.error === 'free_audits_exhausted';
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
    send({ message: t }, t);
  }

  // The voice panel outlives re-renders; it always calls the newest `send`.
  const sendRef = useRef(send);
  sendRef.current = send;

  const lastAssistant = [...items].reverse().find((i) => i.role === 'assistant')?.id;

  return (
    <div className="mx-auto flex h-[calc(100dvh-9rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background-elevated">
      <div className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4" aria-live="polite">
        {items.map((i) =>
          i.role === 'user' ? (
            <div key={i.id} className="flex justify-start">
              <p className="max-w-[85%] rounded-2xl rounded-ss-sm bg-primary/10 px-3.5 py-2 text-[14px] leading-7 text-foreground">
                {i.text}
              </p>
            </div>
          ) : (
            <div key={i.id} className="flex flex-col items-end gap-2">
              <p className="max-w-[92%] whitespace-pre-line rounded-2xl rounded-se-sm bg-card px-3.5 py-2 text-[14px] leading-7 text-foreground shadow-sm">
                {i.text}
              </p>
              {i.cards.map((c, idx) => (
                <CardView key={idx} card={c} />
              ))}
              {i.id === lastAssistant && i.actions.length > 0 && (
                <div className="flex max-w-full flex-wrap justify-end gap-2">
                  {i.actions.map((q, idx) => (
                    <ActionButton key={idx} q={q} disabled={!!busy} onAction={onAction} recId={recIdOf(q.action)} />
                  ))}
                </div>
              )}
            </div>
          )
        )}
        {busy && (
          <div className="flex items-center justify-end gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {busy === 'audit' ? 'أفحص حسابك، ياخذ دقائق قليلة…' : 'ثواني…'}
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-foreground"
            >
              <Square className="h-3 w-3" /> إلغاء
            </button>
          </div>
        )}
        {failed && !busy && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => failed()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px]"
            >
              <RotateCcw className="h-3.5 w-3.5" /> أعد المحاولة
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-border p-2.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          placeholder="اكتب سؤالك بكلامك…"
          aria-label="رسالتك"
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-[14px]"
        />
        {voiceEnabled && (
          <button
            type="button"
            onClick={() => setVoiceOpen((open) => !open)}
            aria-label="مكالمة صوتية"
            aria-pressed={voiceOpen}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-foreground"
          >
            <AudioLines className="h-4 w-4" />
          </button>
        )}
        <button
          type="submit"
          disabled={!text.trim() || !!busy}
          aria-label="إرسال"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40"
        >
          <Send className="h-4 w-4 rtl:-scale-x-100" />
        </button>
      </form>
      {voiceEnabled && voiceOpen && (
        <VoiceCallPanel
          customerId={customerId}
          onUtterance={(spoken, ticket) => sendRef.current({ message: spoken }, spoken, ticket)}
          onClose={() => setVoiceOpen(false)}
        />
      )}
      {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}
      <div className="flex items-center justify-center gap-4 border-t border-border px-3 py-2 text-center text-xs text-muted-foreground">
        <button type="button" onClick={() => setMemoryOpen((open) => !open)} className="underline underline-offset-4">
          وش أعرف عن نشاطك
        </button>
        <Link href="/dashboard" className="underline underline-offset-4">
          تبي التفاصيل؟ افتح اللوحة الكاملة
        </Link>
      </div>
    </div>
  );
}

function quickStart(): ChatQuickAction[] {
  return [
    { label: 'وش خطة اليوم؟', action: { type: 'say', text: 'وش أهم شي أسويه اليوم في إعلاناتي؟' } },
    { label: 'وش وضع حسابي؟', action: { type: 'say', text: 'وش وضع حسابي' } },
    { label: 'افحص حسابي', action: { type: 'say', text: 'افحص حسابي' } },
    { label: 'وش أحسن خطوة؟', action: { type: 'say', text: 'وش التوصيات' } },
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
    'rounded-xl border border-primary/30 bg-primary/[0.07] px-3.5 py-2 text-[13px] font-medium text-foreground disabled:opacity-50';
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
  return (
    <form method="post" action="/api/recommendations/action">
      <input type="hidden" name="recommendation_id" value={recId} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value="/start" />
      <button type="submit" disabled={disabled} className={className}>
        {label}
      </button>
    </form>
  );
}

function CardView({ card }: { card: ChatCard }) {
  const box = 'w-full max-w-[92%] rounded-xl border border-border bg-card p-3 text-[13px] leading-7';
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
            <p>هدر شهري تقديري: {Math.round(card.estimatedMonthlyWaste).toLocaleString('en-US')} دولار</p>
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
        <div className={`${box} border-primary/40`}>
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
  const live = !card.status || OPEN_STATUSES.has(card.status);
  const btn =
    'rounded-xl border px-3.5 py-2 text-[13px] font-medium disabled:opacity-50';
  return (
    <div id={`card-${card.recommendationId}`} className="w-full max-w-[92%] rounded-xl border border-primary/40 bg-card p-3 text-[13px] leading-7">
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
          <input type="hidden" name="next" value="/start" />
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
              intent="approve_execute"
              label="اعتمد"
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
    <div className="w-full max-w-[92%] rounded-xl border border-border bg-card p-3 text-[13px] leading-7">
      <p className="text-[11px] text-muted-foreground">حفظت عن نشاطك</p>
      <p className={state === 'deleted' ? 'line-through text-muted-foreground' : ''}>{card.fact}</p>
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
  const [answer, setAnswer] = useState<null | 'auto_small' | 'always_ask' | 'saving' | 'failed'>(null);
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
  const btn = 'rounded-xl border px-3.5 py-2 text-[13px] font-medium disabled:opacity-50';
  if (answer === 'auto_small' || answer === 'always_ask') {
    return (
      <div className="w-full max-w-[92%] rounded-xl border border-border bg-card p-3 text-[13px] leading-7">
        {answer === 'auto_small'
          ? 'تمام. أول ما يفتح التنفيذ التلقائي في المنصة أشغّله لك على التعديلات الصغيرة بس، وللحين أجهز وأنت تعتمد.'
          : 'تمام، بستأذنك في كل تعديل.'}
      </div>
    );
  }
  return (
    <div className="w-full max-w-[92%] rounded-xl border border-primary/40 bg-card p-3 text-[13px] leading-7">
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
    <div className="max-h-64 overflow-y-auto border-t border-border bg-card px-3 py-2 text-[13px] leading-7">
      <div className="mb-1 flex items-center justify-between">
        <p className="font-semibold">وش أعرف عن نشاطك</p>
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
