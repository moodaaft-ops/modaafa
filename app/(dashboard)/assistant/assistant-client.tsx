'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Mic, Send, Sparkles, TrendingUp } from 'lucide-react';
import { googleAdsAccountDisplayName } from '@/lib/accounts/display';
import { biddingLabel, campaignTypeLabel } from '@/lib/ui/labels';
import { EmptyState } from '@/lib/ui/empty-state';
import { Alert } from '@/lib/ui/alert';
import { buttonClasses } from '@/lib/ui/button';
import { inputClasses, selectClasses } from '@/lib/ui/field';
import { cn } from '@/lib/utils';

type Account = {
  customer_id: string;
  customer_name: string | null;
};

type ChatItem = {
  role: 'user' | 'assistant';
  content: string;
  cards?: Array<{ label: string; value: string }>;
  draft?: any;
  recommendations?: Array<{ title: string; status: string; severity: string; description?: string | null }>;
  aiBackend?: 'model' | 'fallback';
  aiWarning?: string | null;
};

const SUGGESTED_PROMPTS = [
  'وش أهم توصية أبدأ فيها؟',
  'حلل الصرف آخر 7 أيام',
  'ما الحملات اللي تحتاج إيقاف؟',
  'اقترح كلمات سلبية محتملة',
  'هل أرفع الميزانية أو أوقف الهدر أولاً؟',
  'ابنِ لي مسودة حملة بحث بميزانية 100 ريال يومياً',
];

const SEED_MESSAGE = 'اختر الحساب واكتب طلبك. أقدر ألخص الأداء، أطلع أولويات، أو أبني مسودة حملة تحتاج موافقتك قبل التنفيذ.';

/** Client-side ceiling; the route itself declares maxDuration = 120. */
const ASSISTANT_TIMEOUT_MS = 110_000;

export function AssistantClient({
  accounts,
  selectedCustomerId,
}: {
  accounts: Account[];
  selectedCustomerId: string | null;
}) {
  const router = useRouter();
  const [isSwitching, startTransition] = useTransition();
  const [switching, setSwitching] = useState(false);
  const [customerId, setCustomerId] = useState(selectedCustomerId ?? accounts[0]?.customer_id ?? '');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const [chat, setChat] = useState<ChatItem[]>([{ role: 'assistant', content: SEED_MESSAGE }]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.customer_id === customerId),
    [accounts, customerId]
  );
  const started = chat.some((item) => item.role === 'user');

  // Keep the conversation scrolled to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, loading]);

  async function handleAccountChange(nextCustomerId: string) {
    if (switching) return;
    setSwitching(true);
    setCustomerId(nextCustomerId);
    setSessionId(null);
    setError('');
    setChat([{ role: 'assistant', content: SEED_MESSAGE }]);

    let response: Response;
    try {
      response = await fetch('/api/accounts/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: nextCustomerId }),
      });
    } catch {
      setError('تعذر تبديل الحساب. تحقق من اتصالك بالإنترنت ثم أعد المحاولة.');
      setSwitching(false);
      return;
    } finally {
      // `isSwitching` from useTransition only turns true AFTER this request
      // resolves, so the select element stayed live during the round trip and
      // fast switching could race.
      setSwitching(false);
    }

    if (!response.ok) {
      setError('تعذر تبديل الحساب. اختر الحساب من القائمة الجانبية ثم أعد المحاولة.');
      return;
    }

    startTransition(() => router.refresh());
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !customerId || loading) return;

    setError('');
    setLoading(true);
    const historyPayload = chat
      .filter((item) => item.content && item.content.trim())
      .slice(-8)
      .map((item) => ({ role: item.role, content: item.content }));
    setChat((items) => [...items, { role: 'user', content: trimmed }]);
    setMessage('');

    // `fetch` REJECTS on a dropped connection, DNS failure, or a tab resumed
    // from sleep. Without try/catch/finally, `setLoading(false)` was never
    // reached: the typing indicator animated forever, the send button stayed
    // disabled, and `sendMessage`'s own `loading` guard blocked every retry —
    // the only way out was a page reload.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), ASSISTANT_TIMEOUT_MS);

    let response: Response;
    let data: any = {};
    try {
      response = await fetch('/api/chat/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, customerId, sessionId, history: historyPayload }),
        signal: controller.signal,
      });
      data = await response.json().catch(() => ({}));
    } catch (err) {
      setError(
        (err as Error)?.name === 'AbortError'
          ? 'استغرق الرد وقتاً أطول من المتوقع. أعد إرسال السؤال أو اختصره قليلاً.'
          : 'تعذر الاتصال بالمساعد. تحقق من اتصالك بالإنترنت ثم أعد الإرسال.'
      );
      return;
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }

    if (!response.ok) {
      setError(errorMessage(data.error));
      return;
    }

    if (data.session_id) setSessionId(data.session_id);

    setChat((items) => [
      ...items,
      {
        role: 'assistant',
        content: data.reply_ar,
        cards: data.cards,
        draft: data.draft_campaign,
        recommendations: data.recommendations,
        aiBackend: data.ai_backend,
        aiWarning: data.ai_warning,
      },
    ]);
  }

  function startVoiceInput() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('المتصفح الحالي لا يدعم الإملاء الصوتي من هذه الصفحة.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'ar-SA';
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      setError('تعذر التقاط الصوت. جرب الكتابة أو أعد المحاولة.');
    };
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) setMessage((current) => (current ? `${current} ${transcript}` : transcript));
    };
    recognition.start();
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Link2}
        title="اربط حساب إعلانات Google أولاً"
        description="المساعد يقرأ بيانات الحساب المختار ليعطيك تحليلاً وتوصيات حقيقية بدل ردود عامة."
        action={
          <a href="/onboarding/connect" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
            ربط إعلانات Google
          </a>
        }
      />
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_290px]">
      <section className="flex h-[calc(100dvh-13rem)] min-h-[520px] flex-col surface-card overflow-hidden">
        {/* Header with account context */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold leading-tight tracking-tight">المساعد الذكي</div>
              <div className="truncate text-[11px] leading-tight text-muted-foreground">
                {selectedAccount ? googleAdsAccountDisplayName(selectedAccount) : customerId}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(isSwitching || switching) && <span className="text-xs text-muted-foreground">جاري التبديل...</span>}
            {accounts.length > 1 && (
              <select
                value={customerId}
                onChange={(event) => handleAccountChange(event.target.value)}
                disabled={isSwitching || switching}
                aria-busy={isSwitching || switching}
                className={cn(selectClasses, 'h-9 max-w-[180px] text-[13px] disabled:cursor-wait disabled:opacity-60')}
                aria-label="اختر الحساب"
              >
                {accounts.map((account) => (
                  <option key={account.customer_id} value={account.customer_id}>
                    {googleAdsAccountDisplayName(account)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="surface-sunken flex-1 overflow-y-auto rounded-none border-0 p-4 scrollbar-thin sm:p-5"
        >
          {!started ? (
            <div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </span>
              <h3 className="mt-5 text-base font-semibold tracking-tight">اسألني عن حسابك</h3>
              <p className="mt-2 max-w-sm text-[13px] leading-7 text-muted-foreground">{SEED_MESSAGE}</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {SUGGESTED_PROMPTS.slice(0, 4).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => sendMessage(prompt)}
                    className="rounded-full border border-border bg-background-elevated px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {chat.map((item, index) => (
                <ChatBubble key={`${item.role}-${index}`} item={item} />
              ))}
              {loading && <TypingIndicator />}
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(message);
          }}
          className="border-t border-border bg-card p-3 sm:p-4"
        >
          {error && (
            <div className="mb-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={startVoiceInput}
              className={cn(
                'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border transition-colors duration-150',
                listening
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border bg-background-elevated text-muted-foreground hover:border-border-strong hover:text-foreground'
              )}
              aria-label="إملاء صوتي"
              title="إملاء صوتي"
            >
              <Mic className="h-4 w-4" />
            </button>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="اسأل عن الأداء أو اطلب مسودة حملة..."
              className={cn(inputClasses, 'min-w-0 flex-1')}
              aria-label="رسالتك"
            />
            <button
              type="submit"
              disabled={loading || !message.trim()}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="إرسال"
              title="إرسال"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </section>

      {/* Side panel */}
      <aside className="space-y-3">
        <section className="surface-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[13px] font-semibold tracking-tight">
            <TrendingUp className="h-3.5 w-3.5 text-primary" />
            أوامر جاهزة
          </div>
          <div className="grid gap-1.5 p-3">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => sendMessage(prompt)}
                disabled={loading}
                className="rounded-lg border border-transparent px-3 py-2.5 text-start text-[13px] leading-6 text-muted-foreground transition-colors duration-150 hover:border-border hover:bg-background-elevated hover:text-foreground disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        </section>
        <section className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4 text-[13px] leading-7 text-muted-foreground">
          كل إجراء تنفيذي يبقى في <b className="font-semibold text-foreground">مركز الموافقات</b> قبل أي تعديل مباشر على
          إعلانات Google.
        </section>
      </aside>
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  const isUser = item.role === 'user';
  return (
    // Alignment follows the universal chat convention rather than the raw
    // logical properties: INCOMING (the assistant) sits at the reading start —
    // the right edge in RTL — and the user's OWN messages sit at the end. The
    // previous version had these swapped, so the user's messages appeared where
    // an Arabic speaker expects the other party's.
    <article
      className={cn(
        'max-w-[85%] animate-fade-in break-words rounded-xl px-4 py-3 text-[13px] leading-7',
        isUser
          ? 'self-end bg-primary text-primary-foreground'
          : 'self-start border border-border bg-card text-foreground'
      )}
    >
      <div className="whitespace-pre-line">{item.content}</div>

      {item.role === 'assistant' && item.aiBackend === 'fallback' && (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-xs leading-6 text-amber-700 dark:text-amber-300">
          {item.aiWarning ?? 'عرضنا تحليلاً احتياطياً لهذه الرسالة لأن المحرك الذكي لم يستجب.'}
        </div>
      )}

      {item.cards && item.cards.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {item.cards.map((card) => (
            <div
              key={card.label}
              className="rounded-lg border border-border bg-background-elevated px-3 py-2 text-foreground"
            >
              <div className="text-[11px] text-muted-foreground">{card.label}</div>
              <div className="mt-0.5 text-[15px] font-semibold tracking-tight numeric">{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {item.recommendations && item.recommendations.length > 0 && (
        <div className="mt-3 space-y-2">
          {item.recommendations.slice(0, 3).map((recommendation) => (
            <div
              key={recommendation.title}
              className="rounded-lg border border-border bg-background-elevated px-3 py-2.5"
            >
              <div className="text-[13px] font-semibold text-foreground">{recommendation.title}</div>
              {recommendation.description && (
                <div className="mt-1 text-xs leading-6 text-muted-foreground">{recommendation.description}</div>
              )}
            </div>
          ))}
          <a
            href="/optimizer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
          >
            فتح مركز الموافقات
          </a>
        </div>
      )}

      {item.draft && (
        <div className="mt-3 rounded-lg border border-primary/25 bg-primary/[0.08] p-3 text-foreground">
          <div className="text-[13px] font-semibold tracking-tight">{item.draft.name}</div>
          <div className="mt-2 grid gap-1.5 text-xs sm:grid-cols-3">
            <span className="text-muted-foreground">النوع: {campaignTypeLabel(item.draft.type)}</span>
            <span className="text-muted-foreground">الميزانية: {item.draft.daily_budget_sar} ر.س/يوم</span>
            <span className="text-muted-foreground">المزايدة: {biddingLabel(item.draft.bidding_strategy)}</span>
          </div>
        </div>
      )}
    </article>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 self-start rounded-xl border border-border bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">المساعد يحلّل الحساب</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-primary"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
    </div>
  );
}

function errorMessage(code?: string) {
  const map: Record<string, string> = {
    account_not_found: 'لم أجد الحساب المرتبط. أعد الربط أو اختر حساباً آخر.',
    message_required: 'اكتب طلبك أولاً.',
    unauthorized: 'انتهت الجلسة. سجل دخولك مرة أخرى.',
    subscription_required: 'هذه الخاصية تحتاج تجربة أو اشتراكاً نشطاً. افتح صفحة الفوترة لاختيار الخطة.',
    quota_exceeded: 'وصلت إلى حد رسائل المساعد المتاح في خطتك لهذه الفترة.',
    usage_storage_unavailable: 'تعذر التحقق من حد الاستخدام الآن. لم ننفذ الطلب، وأعد المحاولة بعد قليل.',
  };
  return map[code ?? ''] ?? 'واجه المساعد مشكلة مؤقتة. أعد المحاولة بعد قليل.';
}
