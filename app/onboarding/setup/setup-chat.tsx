'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Loader2, Lock, MessageCircle, RotateCcw } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { ASSISTANT } from '@/lib/assistant/persona';
import { AssistantAvatar, TypingSquares } from '@/lib/ui/assistant-avatar';
import { LogoMark } from '@/lib/ui/logo';
import { accountsCountLabel } from '@/lib/onboarding/account-choice';
import { CONNECT_ERROR_MESSAGES, connectPollDelayMs, type ConnectProgressView } from '@/lib/onboarding/connect-progress';
import { recommendationsCountLabel } from '@/lib/onboarding/first-opportunities';
import { NO_ACCOUNT_PATH } from '@/lib/onboarding/ads-guide';
import { whatsappHelpUrl, type WhatsAppHelpReason } from '@/lib/support/contact';
import { formatAmount, type SetupKey } from '@/lib/setup/questions';
import { healthWord } from '@/lib/setup/stage';
import { PLAN_COPY, PLAN_LATER_PATH, type Plan } from '@/lib/plan/plan';
import { PlanCard, PlanCta } from '@/lib/plan/plan-paywall';
import type { SetupAccount, SetupFinding, SetupState } from '@/lib/setup/load';
import { useFirstAudit } from './use-first-audit';
import { AccountDock, AnswerTile, QuestionDock, type AnswerPayload } from './docks';

type Line =
  | { id: string; from: 'assistant'; kind: 'text'; text: string; big?: boolean; note?: string }
  | { id: string; from: 'me'; kind: 'text'; text: string }
  | { id: string; from: 'assistant'; kind: 'connecting' }
  | { id: string; from: 'assistant'; kind: 'audit' }
  | { id: string; from: 'assistant'; kind: 'score'; score: number | null; waste: number | null; currency: string }
  | { id: string; from: 'assistant'; kind: 'findings'; findings: SetupFinding[]; currency: string }
  | { id: string; from: 'assistant'; kind: 'plan'; plan: Plan; trialEligible: boolean };

type Dock =
  | { kind: 'none' }
  | { kind: 'connect' }
  | { kind: 'no_account' }
  | { kind: 'connect_retry'; reason: WhatsAppHelpReason; canContinue: boolean }
  | { kind: 'choose' }
  | { kind: 'question'; key: SetupKey }
  | { kind: 'audit_retry' }
  | { kind: 'final' }
  /** «خطتك جاهزة»: the audit is in and there is no access yet. */
  | { kind: 'plan' }
  | { kind: 'edit_done' };

type Phase = 'connect' | 'connecting' | 'choose' | 'questions' | 'finishing' | 'result';

let seq = 0;
const nid = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Friendly words for the errors Google's round trip can come back with. */
const CONNECT_ERRORS: Record<string, string> = {
  access_denied: 'شكلك ما كمّلت الموافقة في شاشة قوقل. جرّب مرة ثانية وكمّلها لين آخر زر.',
  no_accounts:
    'البريد اللي اخترته ما عليه حساب إعلانات قوقل. غالباً حسابك على بريد ثاني، أو الحساب ما انفتح أصلاً.',
  no_client_accounts:
    'لقيت حسابات إدارية (MCC) بس، وما تحتها حساب إعلانات. أحتاج حساب إعلانات واحد على الأقل عشان أقرأ أرقامه.',
  state_mismatch: 'انقطعت خطوة الربط في النص. اضغط الزر مرة ثانية وكمّل في نفس التبويب.',
  restart_link: 'انقطعت خطوة الربط في النص. اضغط الزر مرة ثانية وكمّل في نفس التبويب.',
  missing_params: 'انقطعت خطوة الربط في النص. اضغط الزر مرة ثانية وكمّل في نفس التبويب.',
  session_expired: 'انقطعت خطوة الربط في النص. اضغط الزر مرة ثانية وكمّل في نفس التبويب.',
  state_user_mismatch:
    'بديت الربط من حساب ثاني على نفس المتصفح. سجّل دخولك بحسابك الصحيح في مُضاعِف، وبعدها اربط من جديد.',
  oauth_failed: 'قوقل ما رد علينا صح هالمرة. جرّب مرة ثانية، ولو تكرر كلمنا على الواتساب.',
  oauth_config_missing: 'الربط مع قوقل واقف من جهتنا مؤقتاً. كلمنا على الواتساب ونرتبه لك.',
  too_many_requests: 'حاولت الربط كذا مرة ورا بعض. انتظر دقيقة وجرّب.',
  security_service_unavailable: 'ما قدرت أتحقق من طلب الربط الحين. جرّب بعد دقيقة.',
  invalid_origin: 'ما قدرت أتحقق من مصدر الطلب. جرّب من داخل المنصة.',
  ...CONNECT_ERROR_MESSAGES,
};

function connectHelpReason(error: string | null): WhatsAppHelpReason {
  if (error === 'no_accounts') return 'no_ads_account';
  if (error === 'no_client_accounts') return 'manager_only';
  return 'connect_failed';
}

function questionCopy(key: SetupKey, s: SetupState): { text: string; why?: string } {
  switch (key) {
    case 'type':
      return { text: 'وش نوع نشاطك؟', why: 'عشان أقارن حسابك بأنشطة تشبهك.' };
    case 'name':
      return s.namePrefill && !s.edit
        ? { text: `نسمي نشاطك «${s.namePrefill}»؟`, why: 'بهذا الاسم تطلع تقاريرك.' }
        : { text: 'وش اسم نشاطك؟', why: 'بهذا الاسم تطلع تقاريرك.' };
    case 'goal':
      return { text: 'متى تقول إن الإعلان نجح؟', why: 'على هذا بحسب كل ريال تصرفه.' };
    case 'value':
      return { text: 'تقريباً كم يجيك من العميل الواحد؟', why: 'عشان أحكم على تكلفة الطلب صح.' };
    case 'budget': {
      const spend = s.selected?.spend30 ?? null;
      const sar = (s.selected?.currency ?? 'SAR') === 'SAR';
      return spend && spend >= 300 && sar && !s.edit
        ? {
            text: `آخر 30 يوم صرفت قرابة ${formatAmount(spend)} ريال على قوقل. كم تبي تصرف بالشهر؟`,
            why: 'أوزن اقتراحاتي على قد ميزانيتك.',
          }
        : { text: 'كم تبي تصرف على إعلانات قوقل بالشهر؟', why: 'أوزن اقتراحاتي على قد ميزانيتك.' };
    }
    case 'regions':
      return { text: 'وين عملاءك؟', why: 'الإعلان اللي يطلع لناس برا منطقتك فلوس رايحة.' };
    case 'manager':
      return { text: 'مين يدير إعلاناتك الحين؟', why: 'عشان أشتغل بطريقة ما تلخبط على أحد.' };
    case 'pain':
      return { text: 'وش أكثر شي مضايقك في إعلاناتك؟', why: 'أبدأ بالشي اللي يوجعك.' };
    case 'website':
      return { text: 'عندك موقع أو متجر على النت؟', why: 'أشيك الصفحة اللي يوصل لها اللي يضغط إعلانك.' };
    case 'consent':
      return {
        text: 'آخر سؤال. التعديلات الصغيرة، مثل إني أوقف عبارة بحث تصرف بدون فايدة، أسويها لحالي وأبلغك؟',
        why: 'أي شي يلمس الميزانية أو يوقف حملة بستأذنك فيه دايماً، وأي تعديل ترجعه خلال 30 يوم.',
      };
  }
}

export function SetupChat({
  initial,
  errorCode,
  adding = false,
}: {
  initial: SetupState;
  errorCode: string | null;
  /** Opened from «إضافة حساب» or «تجديد الربط» by someone who already uses the app. */
  adding?: boolean;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [typing, setTyping] = useState(false);
  const [dock, setDock] = useState<Dock>({ kind: 'none' });
  const [phase, setPhase] = useState<Phase>('connect');
  const [state, setState] = useState<SetupState>(initial);
  const [connectView, setConnectView] = useState<ConnectProgressView | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(0);
  const [total, setTotal] = useState(Math.max(1, initial.pending.length));

  const stateRef = useRef(initial);
  stateRef.current = state;
  const queueRef = useRef<SetupKey[]>([]);
  const historyRef = useRef<SetupKey[]>([]);
  const waitingForAuditRef = useRef(false);
  const alive = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);
  const reduced = useRef(false);

  const audit = useFirstAudit(state.selected?.customerId ?? null);
  const auditRef = useRef(audit);
  auditRef.current = audit;

  useEffect(() => {
    // Set on every mount: React's development double mount runs the cleanup once in between.
    alive.current = true;
    reduced.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const behavior = reduced.current ? 'auto' : 'smooth';
    // The plan is taller than the space above its CTA: show it from its title, not from its end.
    if (dock.kind === 'plan' && lines.at(-1)?.from === 'assistant' && (lines.at(-1) as { kind?: string })?.kind === 'plan') {
      document.getElementById('plan-card')?.scrollIntoView({ block: 'start', behavior });
      return;
    }
    endRef.current?.scrollIntoView({ block: 'end', behavior });
  }, [lines, typing, dock]);

  const push = useCallback((line: Line) => setLines((cur) => [...cur, line]), []);

  /** «مُضاعِف» types, then the line appears. Longer lines take a little longer, never long. */
  const say = useCallback(
    async (text: string, opts: { big?: boolean; note?: string } = {}) => {
      if (!alive.current) return;
      setTyping(true);
      await sleep(reduced.current ? 120 : Math.min(1100, 380 + text.length * 9));
      if (!alive.current) return;
      setTyping(false);
      push({ id: nid(), from: 'assistant', kind: 'text', text, ...opts });
      await sleep(reduced.current ? 40 : 160);
    },
    [push]
  );

  const me = useCallback((text: string) => push({ id: nid(), from: 'me', kind: 'text', text }), [push]);

  const reload = useCallback(async (): Promise<SetupState | null> => {
    try {
      const res = await fetch(`/api/setup/state${stateRef.current.edit ? '?edit=1' : ''}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login?next=/onboarding');
        return null;
      }
      if (!res.ok) return null;
      const next = (await res.json()) as SetupState;
      setState(next);
      stateRef.current = next;
      return next;
    } catch {
      return null;
    }
  }, [router]);

  // ---------------------------------------------------------------- results

  const showResults = useCallback(
    async (s: SetupState) => {
      setPhase('result');
      setDock({ kind: 'none' });
      const currency = s.selected?.currency ?? 'SAR';
      // No access yet: the audit becomes «خطتك جاهزة» (the summary, the first
      // decision open, the rest locked) with the trial CTA, in place of the
      // result bubbles and the old «نفّذها لي» step.
      if (!s.subscriptionActive && s.plan) {
        await say(s.audit ? 'خلصت الفحص.' : 'الفحوصات المجانية لهذا الحساب انستخدمت قبل.');
        push({ id: nid(), from: 'assistant', kind: 'plan', plan: s.plan, trialEligible: s.trialEligible });
        setDock({ kind: 'plan' });
        return;
      }
      if (!s.audit) {
        await say('الفحوصات المجانية لهذا الحساب انستخدمت قبل.');
        await say(
          s.subscriptionActive
            ? 'تقدر تفحص من جديد من صفحتك.'
            : 'تقدر تفعّل الاشتراك وأفحصه من جديد، أو تدخل صفحتك وتسألني عن حسابك.'
        );
        setDock({ kind: 'final' });
        return;
      }
      await say(`خلصت الفحص. صحة حسابك ${s.audit.healthScore ?? '؟'} من 100.`);
      push({
        id: nid(),
        from: 'assistant',
        kind: 'score',
        score: s.audit.healthScore,
        waste: s.audit.estimatedMonthlyWaste,
        currency,
      });
      if (s.audit.estimatedMonthlyWaste && s.audit.estimatedMonthlyWaste > 0) {
        await say(
          `وتقديري إن قرابة ${formatCurrency(s.audit.estimatedMonthlyWaste, currency)} بالشهر تروح على أشياء ما تجيب لك شي.`,
          { note: 'هذا تقدير من أرقام حسابك، مو رقم نهائي.' }
        );
      }
      if (s.findings.length > 0) {
        await say(`لقيت ${recommendationsCountLabel(s.findingsTotal)}، وهذي أهمها:`);
        push({ id: nid(), from: 'assistant', kind: 'findings', findings: s.findings, currency });
      } else {
        await say('وما لقيت شي يحتاج قرارك الحين.');
      }
      await say('من اليوم أنا معك. أقرأ حسابك كل يوم، وأحط لك قرارات اليوم في صفحتك وأنت تعتمدها بضغطة.');
      if (!s.subscriptionActive) {
        await say(
          s.trialEligible
            ? 'عشان أنفذ أي تعديل على حسابك أحتاج اشتراكك، وأول 14 يوم مجاناً وتلغي متى ما بغيت.'
            : 'عشان أنفذ أي تعديل على حسابك أحتاج اشتراك فعّال.'
        );
      }
      setDock({ kind: 'final' });
    },
    [push, say]
  );

  // ------------------------------------------------------------- questions

  const finishQuestions = useCallback(async () => {
    const s = stateRef.current;
    if (s.edit) {
      setPhase('result');
      await say('حفظت كل شي. وأي شي يتغير في نشاطك بعدين قله لي بالكلام وأحفظه.');
      setDock({ kind: 'edit_done' });
      return;
    }
    setPhase('finishing');
    const kind = auditRef.current.status.kind;
    if (kind === 'done' || s.audit) {
      const next = (await reload()) ?? s;
      await showResults(next);
      return;
    }
    if (kind === 'exhausted') {
      const next = (await reload()) ?? s;
      await showResults(next);
      return;
    }
    await say('خلصنا الأسئلة. أعطني لحظة أخلّص فحص حسابك.');
    push({ id: nid(), from: 'assistant', kind: 'audit' });
    waitingForAuditRef.current = true;
    if (kind === 'idle' || kind === 'error') void auditRef.current.retry();
  }, [push, reload, say, showResults]);

  const askNext = useCallback(async () => {
    const key = queueRef.current.shift();
    if (!key) {
      await finishQuestions();
      return;
    }
    setAsked((n) => n + 1);
    const copy = questionCopy(key, stateRef.current);
    await say(copy.text, { big: true, note: copy.why });
    setDock({ kind: 'question', key });
  }, [finishQuestions, say]);

  const beginQuestions = useCallback(
    async (s: SetupState, ctx: { accountName?: string | null } = {}) => {
      setPhase('questions');
      queueRef.current = [...s.pending];
      historyRef.current = [];
      setTotal(Math.max(1, s.pending.length));
      setAsked(0);
      if (s.edit) {
        await say('نعدّل معلومات نشاطك. اختر الجواب الجديد، والحالي عليه علامة.');
      } else {
        if (ctx.accountName) await say(`تمام، نبدأ بحساب «${ctx.accountName}».`);
        if (s.pending.length > 1) {
          await say(
            s.audit
              ? `عندي ${s.pending.length} أسئلة سريعة، كل واحد بضغطة.`
              : `عندي ${s.pending.length} أسئلة سريعة، كل واحد بضغطة. وأنا أفحص حسابك وأنت تجاوب.`
          );
        }
        // With the business type already on record the audit can start right away.
        if (!s.audit && !s.pending.includes('type')) void auditRef.current.start();
      }
      await askNext();
    },
    [askNext, say]
  );

  const submitAnswer = useCallback(
    async (key: SetupKey, payload: AnswerPayload) => {
      if (busy) return;
      setBusy(true);
      setDock({ kind: 'none' });
      me(payload.label);
      try {
        if (key === 'consent') {
          const res = await fetch('/api/autopilot/consent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              customerId: stateRef.current.selected?.customerId,
              answer: payload.answer.choice,
              channel: 'chat',
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error('save_failed');
          await say(
            payload.answer.choice === 'always_ask'
              ? 'تمام، بستأذنك في كل شي.'
              : data.execution_globally_enabled
                ? 'تمام، الصغيرة أسويها وأبلغك، والباقي أستأذنك فيه.'
                : 'تمام. التنفيذ التلقائي للحين مقفول في المنصة، فأجهز لك وأنت تعتمد، وأول ما يفتح أشغّله على الصغيرة بس.'
          );
        } else {
          const res = await fetch('/api/setup/answer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key, answer: payload.answer }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(String(data.error ?? 'save_failed'));
          if (data.reaction) await say(String(data.reaction));
          if (key === 'type' && !stateRef.current.edit && !stateRef.current.audit) void auditRef.current.start();
          if (key === 'name' || key === 'budget' || key === 'website') {
            // Keep the copy of later questions in step with what was just saved.
            setState((cur) => {
              const next = { ...cur, answered: { ...cur.answered, [key]: payload.answer.choice ?? null } };
              stateRef.current = next;
              return next;
            });
          }
        }
        historyRef.current.push(key);
        setBusy(false);
        await askNext();
      } catch (error) {
        setBusy(false);
        const code = error instanceof Error ? error.message : '';
        await say(
          code === 'invalid_website'
            ? 'الرابط هذا ما ضبط معي. اكتبه مثل mystore.com'
            : code === 'too_many_requests'
              ? 'استعجلت علي شوي. انتظر دقيقة وجاوب.'
              : 'ما انحفظ جوابك. جرّب مرة ثانية.'
        );
        setDock({ kind: 'question', key });
      }
    },
    [askNext, busy, me, say]
  );

  const goBack = useCallback(
    async (current: SetupKey) => {
      const previous = historyRef.current.pop();
      if (!previous) return;
      setDock({ kind: 'none' });
      me('أبي أغيّر جوابي اللي قبل');
      queueRef.current = [previous, current, ...queueRef.current];
      setAsked((n) => Math.max(0, n - 2));
      await askNext();
    },
    [askNext, me]
  );

  // --------------------------------------------------------- account choice

  const askChoose = useCallback(
    async (s: SetupState) => {
      setPhase('choose');
      await say(`لقيت عندك ${accountsCountLabel(s.accounts.length)}. أي واحد نبدأ فيه؟`, {
        big: true,
        note: s.accounts.some((a) => a.spend30 !== null)
          ? 'رتبتها حسب الصرف آخر 30 يوم. وتقدر تبدّل بعدين.'
          : 'وتقدر تبدّل بعدين.',
      });
      setDock({ kind: 'choose' });
    },
    [say]
  );

  const continueFrom = useCallback(
    async (s: SetupState, ctx: { accountName?: string | null } = {}) => {
      if (s.stage === 'choose') return askChoose(s);
      if (s.stage === 'questions') return beginQuestions(s, ctx);
      if (s.stage === 'finishing') {
        if (ctx.accountName) await say(`تمام، نبدأ بحساب «${ctx.accountName}».`);
        queueRef.current = [];
        void auditRef.current.start();
        return finishQuestions();
      }
      if (s.stage === 'done') {
        if (s.edit) return finishQuestions();
        setPhase('result');
        await say('تمام، حساباتك مربوطة. وتقدر تبدّل بينها من القائمة فوق.');
        setDock({ kind: 'edit_done' });
        return;
      }
      if (s.stage === 'connect') {
        setPhase('connect');
        await say('ما وصلني أي حساب من قوقل. جرّب الربط مرة ثانية.');
        setDock({ kind: 'connect' });
      }
    },
    [askChoose, beginQuestions, finishQuestions, say]
  );

  const chooseAccount = useCallback(
    async (account: SetupAccount) => {
      if (busy) return;
      setBusy(true);
      setDock({ kind: 'none' });
      me(account.name);
      try {
        const res = await fetch('/api/accounts/select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customerId: account.customerId }),
        });
        if (!res.ok) throw new Error('select_failed');
        const next = await reload();
        setBusy(false);
        if (!next) throw new Error('reload_failed');
        await continueFrom(next, { accountName: account.name });
      } catch {
        setBusy(false);
        await say('ما قدرت أحفظ اختيارك. جرّب مرة ثانية.');
        setDock({ kind: 'choose' });
      }
    },
    [busy, continueFrom, me, reload, say]
  );

  // -------------------------------------------------------------- connecting

  const pollConnect = useCallback(async () => {
    const startedAt = Date.now();
    let failures = 0;
    for (;;) {
      if (!alive.current) return;
      let view: (ConnectProgressView & { linkedAccounts?: number }) | null = null;
      try {
        const res = await fetch('/api/onboarding/connect-status', { cache: 'no-store' });
        if (res.status === 401) {
          router.replace('/login?next=/onboarding');
          return;
        }
        if (res.ok) view = await res.json();
      } catch {
        view = null;
      }
      if (!view) {
        failures += 1;
        if (failures >= 6) {
          await say('الاتصال متقطع عندك. الربط شغال عندنا، وهذي الصفحة تحاول لحالها.');
          failures = 0;
        }
      } else {
        failures = 0;
        setConnectView(view);
        if (view.phase === 'done') {
          const next = await reload();
          if (!next) {
            await say('خلص الربط بس ما قدرت أفتح حساباتك. حدّث الصفحة.');
            return;
          }
          await say('تمام، وصلت حساباتك.');
          await continueFrom(next, { accountName: next.stage === 'choose' ? null : next.selected?.name });
          return;
        }
        if (view.phase === 'failed' || view.phase === 'timed_out' || (view.phase === 'none' && Date.now() - startedAt > 8000)) {
          const error = view.phase === 'none' ? 'connect_failed' : view.error;
          await say(CONNECT_ERRORS[error ?? ''] ?? CONNECT_ERRORS.connect_failed);
          setPhase('connect');
          setDock({ kind: 'connect_retry', reason: connectHelpReason(error), canContinue: (view.linkedAccounts ?? 0) > 0 });
          return;
        }
      }
      await sleep(connectPollDelayMs(Date.now() - startedAt));
    }
  }, [continueFrom, reload, router, say]);

  // ------------------------------------------------------------------ intro

  const introRan = useRef(false);
  useEffect(() => {
    if (introRan.current) return;
    introRan.current = true;
    const s = initial;
    (async () => {
      if (s.edit) {
        await beginQuestions(s);
        return;
      }
      if (adding) {
        setPhase('connect');
        if (errorCode && CONNECT_ERRORS[errorCode]) {
          await say(CONNECT_ERRORS[errorCode]);
          setDock({ kind: 'connect_retry', reason: connectHelpReason(errorCode), canContinue: false });
          return;
        }
        await say(
          s.revokedCount > 0
            ? 'صلاحية ربط بعض حساباتك مع قوقل انتهت. جدّد الربط وأرجّعها لك.'
            : 'نضيف حساب ثاني؟ اضغط الزر، واختر في شاشة قوقل البريد اللي عليه الحساب.',
          { big: true }
        );
        setDock({ kind: 'connect' });
        return;
      }
      if (s.stage === 'connecting') {
        setPhase('connecting');
        await say('وصلتني موافقة قوقل. أسحب حساباتك الحين.');
        push({ id: nid(), from: 'assistant', kind: 'connecting' });
        await pollConnect();
        return;
      }
      if (s.stage === 'connect') {
        setPhase('connect');
        if (errorCode && CONNECT_ERRORS[errorCode]) {
          await say(CONNECT_ERRORS[errorCode]);
          setDock({ kind: 'connect_retry', reason: connectHelpReason(errorCode), canContinue: false });
          return;
        }
        await say(`هلا${s.firstName ? ` ${s.firstName}` : ''}، أنا ${ASSISTANT.name}.`, { big: true });
        if (s.revokedCount > 0) {
          await say('صلاحية ربط حسابك مع قوقل انتهت. اربطه من جديد ونكمل من وين وقفنا.');
        } else {
          await say('كل يوم أقرأ حساب إعلانات قوقل حقك وأقول لك وين تروح فلوسك، وأي تعديل أجهزه لك وأنت تعتمده بضغطة.');
          await say('نبدأ بربط الحساب. قوقل بيسألك توافق، وبعدها ترجع لي هنا.');
        }
        setDock({ kind: 'connect' });
        return;
      }
      if (s.stage === 'choose') {
        await say(`هلا${s.firstName ? ` ${s.firstName}` : ''}.`);
        await askChoose(s);
        return;
      }
      if (s.stage === 'questions') {
        await say(`هلا${s.firstName ? ` ${s.firstName}` : ''}، أنا ${ASSISTANT.name}.`, { big: true });
        await beginQuestions(s);
        return;
      }
      if (s.stage === 'finishing') {
        await say(`هلا${s.firstName ? ` ${s.firstName}` : ''}. باقي الفحص وأعرض لك النتيجة.`);
        void auditRef.current.start();
        queueRef.current = [];
        await finishQuestions();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------- audit watcher

  useEffect(() => {
    if (!waitingForAuditRef.current) return;
    const kind = audit.status.kind;
    if (kind === 'done' || kind === 'exhausted') {
      waitingForAuditRef.current = false;
      (async () => {
        const next = (await reload()) ?? stateRef.current;
        await showResults(next);
      })();
    } else if (kind === 'error') {
      waitingForAuditRef.current = false;
      (async () => {
        await say(`ما كمل الفحص. ${audit.status.kind === 'error' ? audit.status.message : ''}`.trim());
        setDock({ kind: 'audit_retry' });
      })();
    }
  }, [audit.status, reload, say, showResults]);

  // A run started before a refresh finishes on the server: watch for its row.
  const waiting = audit.status.kind === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      const next = await reload();
      if (next?.audit) {
        clearInterval(timer);
        auditRef.current.markDone();
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  // --------------------------------------------------------------- progress

  const progress = useMemo(() => {
    if (phase === 'connect') return 0.06;
    if (phase === 'connecting') return 0.14;
    if (phase === 'choose') return 0.2;
    if (phase === 'questions') return 0.22 + 0.68 * Math.min(1, Math.max(0, asked - 1) / total);
    if (phase === 'finishing') return 0.94;
    return 1;
  }, [asked, phase, total]);

  const auditBadge =
    phase === 'questions' && (audit.status.kind === 'running' || audit.status.kind === 'waiting')
      ? audit.status.kind === 'running'
        ? `${ASSISTANT.name} يفحص حسابك ${Math.round(audit.status.percent)}%`
        : `${ASSISTANT.name} يفحص حسابك`
      : null;

  const lastAssistantId = [...lines].reverse().find((line) => line.from === 'assistant')?.id;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" dir="rtl">
      {/* Header: the mark, the question count and one thin progress rule. */}
      <header className="relative border-b border-border/60">
        <div className="mx-auto flex h-14 max-w-[720px] items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-2">
            <LogoMark size={22} alt="" />
            <span className="text-[14px] font-bold">مُضاعِف</span>
          </div>
          <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
            {auditBadge && (
              <span className="hidden items-center gap-1.5 sm:inline-flex" aria-live="polite">
                <AssistantAvatar size={18} framed={false} thinking />
                {auditBadge}
              </span>
            )}
            {phase === 'questions' && (
              <span className="numeric" aria-live="polite">
                {Math.min(asked, total)} من {total}
              </span>
            )}
            {(state.edit || adding) && (
              <Link href="/home" className="inline-flex min-h-9 items-center rounded-full px-3 font-semibold text-foreground hover:bg-muted">
                رجوع لصفحتك
              </Link>
            )}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-[-1px] h-[3px] bg-transparent" aria-hidden>
          <div
            className="h-full bg-signal transition-[width] duration-500 ease-out"
            style={{ width: `${Math.round(progress * 100)}%`, marginInlineStart: 0 }}
          />
        </div>
      </header>

      {/* Transcript */}
      <main className="flex-1 overflow-y-auto" aria-live="polite">
        <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 pb-8 pt-8">
          {lines.map((line, index) => {
            const previous = lines[index - 1];
            const showAvatar = line.from === 'assistant' && previous?.from !== 'assistant';
            if (line.from === 'me') {
              return (
                <div key={line.id} className="flex justify-end motion-safe:animate-bubble-in">
                  <p className="max-w-[80%] rounded-[22px] bg-muted px-4 py-2.5 text-[15.5px] leading-7 text-foreground">
                    {line.text}
                  </p>
                </div>
              );
            }
            return (
              <div key={line.id} className="flex items-start gap-3 motion-safe:animate-bubble-in">
                {/* Like the home chat: the mark sits beside the reply from sm up; on a phone the reply takes the width. */}
                <div className="hidden w-7 flex-shrink-0 pt-1 sm:block">
                  {showAvatar && <AssistantAvatar size={28} thinking={typing && line.id === lastAssistantId} />}
                </div>
                <div className="min-w-0 flex-1">
                  <AssistantLine line={line} connectView={connectView} audit={audit.status} />
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="flex items-center gap-3">
              <div className="hidden w-7 flex-shrink-0 sm:block">
                {lines.at(-1)?.from !== 'assistant' && <AssistantAvatar size={28} thinking />}
              </div>
              <div className="py-2">
                <TypingSquares />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      {/* Answer dock */}
      {dock.kind !== 'none' && !typing && (
        <section
          className="bg-background motion-safe:animate-bubble-in"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
          aria-label="جوابك"
        >
          <div className="mx-auto max-h-[56dvh] max-w-[720px] overflow-y-auto px-4 pt-3">
            <DockView
              dock={dock}
              state={state}
              busy={busy}
              canBack={phase === 'questions' && historyRef.current.length > 0}
              onAnswer={submitAnswer}
              onBack={goBack}
              onChoose={chooseAccount}
              onNoAccount={async () => {
                setDock({ kind: 'none' });
                me('ما عندي حساب إعلانات');
                await say('ولا يهمك. نفتحه لك مجاناً على الواتساب، أو تفتحه بنفسك بالخطوات وترجع لي.');
                setDock({ kind: 'no_account' });
              }}
              onContinueWithAccounts={async () => {
                setDock({ kind: 'none' });
                const next = await reload();
                if (next) await continueFrom(next);
              }}
              onAuditRetry={async () => {
                setDock({ kind: 'none' });
                me('أعد الفحص');
                waitingForAuditRef.current = true;
                push({ id: nid(), from: 'assistant', kind: 'audit' });
                audit.retry();
              }}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function AssistantLine({
  line,
  connectView,
  audit,
}: {
  line: Exclude<Line, { from: 'me' }>;
  connectView: ConnectProgressView | null;
  audit: ReturnType<typeof useFirstAudit>['status'];
}) {
  // Words are plain text like the home chat; only structured things get a soft card.
  const bubble = 'rounded-[18px] border border-border/80 bg-card p-4';
  switch (line.kind) {
    case 'text':
      return (
        <div>
          <p className={cn('text-foreground', line.big ? 'text-[19px] font-semibold leading-9' : 'text-[15.5px] leading-8')}>
            {line.text}
          </p>
          {line.note && <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">{line.note}</p>}
        </div>
      );
    case 'connecting': {
      const stages = connectView?.stages ?? [];
      return (
        <ol className={cn(bubble, 'space-y-2.5')}>
          {(stages.length ? stages : [{ id: 'discover', label: 'نكتشف حساباتك', state: 'active' as const }]).map((stage) => (
            <li key={stage.id} className="flex items-center gap-2.5 text-[14.5px]">
              <span
                className={cn(
                  'h-2.5 w-2.5 flex-shrink-0 rounded-full',
                  stage.state === 'done' && 'bg-foreground',
                  stage.state === 'active' && 'bg-signal motion-safe:animate-lamp-blink',
                  stage.state === 'pending' && 'border border-border-strong',
                  stage.state === 'failed' && 'bg-danger'
                )}
                aria-hidden
              />
              <span className={stage.state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>{stage.label}</span>
            </li>
          ))}
        </ol>
      );
    }
    case 'audit': {
      const percent =
        audit.kind === 'running' ? Math.max(4, Math.min(100, audit.percent)) : audit.kind === 'done' ? 100 : null;
      return (
        <div className={bubble}>
          <p className="text-[15px] font-semibold">
            {audit.kind === 'done' ? 'خلص الفحص' : audit.kind === 'running' ? audit.message : 'الفحص شغال عندي'}
          </p>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <div
              className={cn('h-full rounded-full bg-foreground transition-[width] duration-500', percent === null && 'motion-safe:animate-pulse')}
              style={{ width: percent === null ? '35%' : `${percent}%` }}
            />
          </div>
          {percent !== null && percent < 100 && <p className="numeric mt-1.5 text-[12px] text-muted-foreground">{Math.round(percent)}%</p>}
        </div>
      );
    }
    case 'score': {
      const word = healthWord(line.score);
      const score = line.score ?? 0;
      return (
        <div className={cn(bubble, 'flex items-center gap-4')}>
          <div className="relative h-[72px] w-[72px] flex-shrink-0" aria-hidden>
            <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="none" className="stroke-muted" strokeWidth="3.5" />
              <circle
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                className={score >= 70 ? 'stroke-foreground' : 'stroke-signal'}
                strokeWidth="3.5"
                strokeDasharray={`${(Math.max(0, Math.min(100, score)) / 100) * 97.4} 97.4`}
              />
            </svg>
            <span className="numeric absolute inset-0 flex items-center justify-center text-[20px] font-bold">{line.score ?? '؟'}</span>
          </div>
          <div>
            <p className="text-[17px] font-bold">{word ?? 'ما قدرت أحسب الدرجة'}</p>
            <p className="text-[13px] text-muted-foreground">صحة الحساب من 100</p>
          </div>
        </div>
      );
    }
    case 'plan':
      return <PlanCard id="plan-card" plan={line.plan} trialEligible={line.trialEligible} />;
    case 'findings':
      return (
        <ol className={cn(bubble, 'space-y-3')}>
          {line.findings.map((finding) => (
            <li key={finding.id} className="flex items-start gap-2.5">
              <span
                className={cn(
                  'mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full',
                  finding.severity === 'critical' ? 'bg-danger' : finding.severity === 'medium' ? 'bg-signal' : 'bg-muted-foreground'
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-[15px] font-semibold leading-7">{finding.title}</p>
                {finding.impactLabel && finding.impactAmount > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    {finding.impactLabel}:{' '}
                    <span className="numeric font-semibold text-foreground">{formatCurrency(finding.impactAmount, line.currency)}</span>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      );
  }
}

function GoogleMark() {
  return (
    <svg className="h-5 w-5 flex-shrink-0" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  );
}

function ConnectButton({ label = 'اربط حساب إعلانات قوقل' }: { label?: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <a
      href="/api/auth/google-ads/connect"
      onClick={() => setLoading(true)}
      aria-busy={loading}
      className="flex h-14 w-full items-center justify-center gap-3 rounded-full bg-primary px-5 text-[16px] font-bold text-primary-foreground transition-colors hover:bg-primary/90"
    >
      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <GoogleMark />}
      {loading ? 'أفتح لك شاشة قوقل…' : label}
    </a>
  );
}

function WhatsAppTile({ reason, email, label }: { reason: WhatsAppHelpReason; email: string | null; label: string }) {
  return (
    <a
      href={whatsappHelpUrl(reason, email)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3 text-start text-[15px] font-semibold text-foreground transition-colors hover:bg-muted"
    >
      <MessageCircle className="h-5 w-5 text-muted-foreground" />
      {label}
    </a>
  );
}

function DockView({
  dock,
  state,
  busy,
  canBack,
  onAnswer,
  onBack,
  onChoose,
  onNoAccount,
  onContinueWithAccounts,
  onAuditRetry,
}: {
  dock: Dock;
  state: SetupState;
  busy: boolean;
  canBack: boolean;
  onAnswer: (key: SetupKey, payload: AnswerPayload) => void;
  onBack: (current: SetupKey) => void;
  onChoose: (account: SetupAccount) => void;
  onNoAccount: () => void;
  onContinueWithAccounts: () => void;
  onAuditRetry: () => void;
}) {
  switch (dock.kind) {
    case 'connect':
      return (
        <div className="space-y-2.5">
          <ConnectButton label={state.revokedCount > 0 ? 'جدّد ربط حساب قوقل' : undefined} />
          <AnswerTile label="ما عندي حساب إعلانات" icon="help" onClick={onNoAccount} />
          <p className="flex items-center justify-center gap-1.5 pt-1 text-[12.5px] text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            ما نغيّر شي في حسابك بدون موافقتك
          </p>
        </div>
      );
    case 'no_account':
      return (
        <div className="space-y-2.5">
          <WhatsAppTile reason="no_ads_account" email={state.email} label="افتحه معي على الواتساب، مجاناً" />
          <Link
            href={NO_ACCOUNT_PATH}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3 text-[15px] font-semibold transition-colors hover:bg-muted"
          >
            أفتحه بنفسي بالخطوات
          </Link>
          <ConnectButton label="فتحته، خلني أربطه" />
        </div>
      );
    case 'connect_retry':
      return (
        <div className="space-y-2.5">
          {dock.canContinue && <AnswerTile label="كمّل بالحسابات اللي وصلت" icon="check" onClick={onContinueWithAccounts} />}
          <ConnectButton label={dock.reason === 'no_ads_account' ? 'جرّب بريد ثاني' : 'جرّب الربط مرة ثانية'} />
          <WhatsAppTile reason={dock.reason} email={state.email} label="كلمنا على الواتساب ونرتبه معك" />
        </div>
      );
    case 'choose':
      return <AccountDock accounts={state.accounts} busy={busy} onChoose={onChoose} />;
    case 'question':
      return (
        <QuestionDock
          k={dock.key}
          state={state}
          busy={busy}
          canBack={canBack}
          onBack={() => onBack(dock.key)}
          onAnswer={(payload) => onAnswer(dock.key, payload)}
        />
      );
    case 'audit_retry':
      return (
        <div className="space-y-2.5">
          <button
            type="button"
            onClick={onAuditRetry}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary text-[16px] font-bold text-primary-foreground"
          >
            <RotateCcw className="h-4 w-4" />
            أعد الفحص
          </button>
          <Link
            href="/home"
            className="flex h-12 w-full items-center justify-center rounded-full border border-border bg-card text-[15px] font-semibold hover:bg-muted"
          >
            أكمل لصفحتي
          </Link>
        </div>
      );
    case 'plan':
      return (
        <div className="space-y-1">
          <PlanCta trialEligible={state.trialEligible} cta={state.cta} />
          <Link
            href={PLAN_LATER_PATH}
            className="flex h-12 w-full items-center justify-center rounded-full text-[15px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {PLAN_COPY.later}
          </Link>
        </div>
      );
    case 'final': {
      const trial = !state.subscriptionActive;
      return (
        <div className="space-y-2.5">
          {trial ? (
            <>
              <Link
                href="/onboarding/trial"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-[16px] font-bold text-primary-foreground"
              >
                {state.trialEligible ? 'نفّذها لي، وأول 14 يوم مجاناً' : 'فعّل الاشتراك عشان أنفذها'}
              </Link>
              <Link
                href="/home"
                className="flex h-12 w-full items-center justify-center rounded-full border border-border bg-card text-[15px] font-semibold hover:bg-muted"
              >
                أشوف صفحتي أول
              </Link>
            </>
          ) : (
            <Link
              href="/home"
              className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary text-[16px] font-bold text-primary-foreground"
            >
              يلا ندخل صفحتك
              <ArrowRight className="h-4 w-4 rotate-180" />
            </Link>
          )}
        </div>
      );
    }
    case 'edit_done':
      return (
        <Link
          href="/home"
          className="flex h-14 w-full items-center justify-center rounded-full bg-primary text-[16px] font-bold text-primary-foreground"
        >
          رجوع لصفحتك
        </Link>
      );
    default:
      return null;
  }
}
