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
import { PROVISIONING_UNAVAILABLE, type ProvisioningInitial } from '@/lib/provisioning/types';
import { ProvisionAccountTile } from '../provision-account-tile';
import { formatAmount, isAdaptiveKey, type SetupKey } from '@/lib/setup/questions';
import { healthWord } from '@/lib/setup/stage';
import { PLAN_COPY, PLAN_LATER_PATH, type Plan } from '@/lib/plan/plan';
import { PlanCard, PlanCta } from '@/lib/plan/plan-paywall';
import type { SetupAccount, SetupFinding, SetupState } from '@/lib/setup/load';
import type { AdaptiveQuestion, FirstCampaignPlan, Opener, ScenarioDecision, UnderstoodRow } from '@/lib/setup/adaptive/types';
import { useFirstAudit } from './use-first-audit';
import { AccountDock, AnswerTile, QuestionDock, type AnswerPayload } from './docks';
import { AdaptiveDock, ConfirmDock } from './adaptive-docks';
import { AgencyQuestionsCard, FirstCampaignCard, FullManagementCard, SeenBox, UnderstoodCard } from './adaptive-cards';
import { agencyPlanSubtitle, auditPermitted, changesTree, replannedQueue, shouldStartAudit } from './adaptive-flow';

type Line =
  | { id: string; from: 'assistant'; kind: 'text'; text: string; big?: boolean; note?: string }
  | { id: string; from: 'me'; kind: 'text'; text: string }
  | { id: string; from: 'assistant'; kind: 'connecting' }
  | { id: string; from: 'assistant'; kind: 'audit' }
  | { id: string; from: 'assistant'; kind: 'score'; score: number | null; waste: number | null; currency: string }
  | { id: string; from: 'assistant'; kind: 'findings'; findings: SetupFinding[]; currency: string }
  | {
      id: string;
      from: 'assistant';
      kind: 'plan';
      plan: Plan;
      trialEligible: boolean;
      /** Adaptive onboarding only (see PlanCard). */
      lead?: ScenarioDecision | null;
      firstWhy?: string | null;
      subtitle?: string | null;
    }
  /** Adaptive onboarding: «اللي شفته», «فهمت عليك», «خطة أول حملة» and the two cards of the agency ending. */
  | { id: string; from: 'assistant'; kind: 'seen'; rows: string[] }
  | { id: string; from: 'assistant'; kind: 'understood'; rows: UnderstoodRow[] }
  | { id: string; from: 'assistant'; kind: 'first_campaign'; campaign: FirstCampaignPlan }
  | { id: string; from: 'assistant'; kind: 'agency_questions'; questions: string[] }
  | { id: string; from: 'assistant'; kind: 'full_management'; email: string | null };

type Dock =
  | { kind: 'none' }
  | { kind: 'connect' }
  | { kind: 'no_account' }
  | { kind: 'connect_retry'; reason: WhatsAppHelpReason; canContinue: boolean }
  | { kind: 'choose' }
  | { kind: 'question'; key: SetupKey; adaptive?: AdaptiveQuestion }
  /** Adaptive: the opener's «صح كذا؟». */
  | { kind: 'confirm'; proposal: Opener['proposal'] }
  | { kind: 'audit_retry' }
  | { kind: 'final' }
  /** «خطتك جاهزة»: the audit is in and there is no access yet. */
  | { kind: 'plan' }
  /** Adaptive: «فهمت عليك» is on screen and waits for «صح، وريني الخطة». */
  | { kind: 'understood' }
  /** Adaptive: the first-campaign plan of someone with no account yet. The way to an account, no «كمّل بدون حساب». */
  | { kind: 'open_account' }
  | { kind: 'edit_done' };

type Phase = 'connect' | 'connecting' | 'choose' | 'questions' | 'finishing' | 'result';

/** The extra tile of the no-account docks in the adaptive path. */
const CONTINUE_WITHOUT_ACCOUNT = 'كمّل بدون حساب، وأجهز لك خطة أول حملة';

/** The ending cards a plan scroll should start from (the plan card has the anchor id). */
const ENDING_CARD_KINDS: readonly string[] = ['plan', 'first_campaign', 'agency_questions', 'full_management'];

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
    default:
      // Adaptive keys carry their own copy (lib/setup/adaptive/bank.ts).
      return { text: '' };
  }
}

export function SetupChat({
  initial,
  errorCode,
  adding = false,
  provisioning = PROVISIONING_UNAVAILABLE,
}: {
  initial: SetupState;
  errorCode: string | null;
  /** Opened from «إضافة حساب» or «تجديد الربط» by someone who already uses the app. */
  adding?: boolean;
  /** «افتحه لي»: when available, the no-account docks offer it in place of the WhatsApp tile. */
  provisioning?: ProvisioningInitial;
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
  const dockRef = useRef<Dock>({ kind: 'none' });
  dockRef.current = dock;
  const askedCountRef = useRef(0);
  askedCountRef.current = asked;
  // The adaptive tree (nothing below is read while `state.adaptive` is null).
  /** Keys asked in this run: in edit mode a re-plan lists every key again, and these are not asked twice. */
  const askedRef = useRef<SetupKey[]>([]);
  /** The copy of every adaptive question seen, so going back to an answered key still has its words. */
  const questionBankRef = useRef<Record<string, AdaptiveQuestion | undefined>>({ ...(initial.adaptive?.questions ?? {}) });
  /** The opener shown, kept so going back to «صح كذا؟» can ask it again after the tree re-planned. */
  const openerRef = useRef<Opener | null>(null);
  const openerShownRef = useRef(false);
  /** The account is read at most once per page load. */
  const readTriedRef = useRef(false);
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
    const last = lines.at(-1);
    const planDock = dock.kind === 'plan' || dock.kind === 'open_account' || dock.kind === 'final';
    if (planDock && last?.from === 'assistant' && ENDING_CARD_KINDS.includes(last.kind)) {
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

  const me = useCallback(
    (text: string) => {
      const id = nid();
      push({ id, from: 'me', kind: 'text', text });
      return id;
    },
    [push]
  );

  /** A card appears after a short typing beat, like a line does. */
  const sayBox = useCallback(
    async (line: Line) => {
      if (!alive.current) return;
      setTyping(true);
      await sleep(reduced.current ? 120 : 420);
      if (!alive.current) return;
      setTyping(false);
      push(line);
      await sleep(reduced.current ? 40 : 160);
    },
    [push]
  );

  /** Adaptive: the server's own words for the customer's answer replace the label that was tapped. */
  const relabel = useCallback((id: string, text: string) => {
    setLines((cur) => cur.map((line) => (line.id === id && line.from === 'me' ? { ...line, text } : line)));
  }, []);

  /**
   * Starts the first audit where the flow wants it. The adaptive states that
   * never spend (new, dormant, no account) never reach /api/audit/run; the
   * legacy flow starts it exactly as before.
   */
  const startAudit = useCallback((s: SetupState) => {
    if (s.adaptive && !shouldStartAudit(s)) return;
    void auditRef.current.start();
  }, []);

  const reload = useCallback(async (): Promise<SetupState | null> => {
    try {
      const res = await fetch(`/api/setup/state${stateRef.current.edit ? '?edit=1' : ''}`, { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login?next=/onboarding');
        return null;
      }
      if (!res.ok) return null;
      const next = (await res.json()) as SetupState;
      if (next.adaptive) Object.assign(questionBankRef.current, next.adaptive.questions);
      setState(next);
      stateRef.current = next;
      return next;
    } catch {
      return null;
    }
  }, [router]);

  // ---------------------------------------------------------------- results

  /**
   * The adaptive ending: the first-campaign plan for new, dormant and no-account
   * customers, «خطتك جاهزة» (with the rules decision open when there is one) for
   * the rest, and for an agency-managed account the plan plus the questions to
   * put to the agency. False means the legacy results are the right answer here
   * (a subscription that is already live, or no plan to show).
   */
  const showAdaptiveEnding = useCallback(
    async (s: SetupState): Promise<boolean> => {
      const adaptive = s.adaptive;
      if (!adaptive) return false;
      const { firstCampaign } = adaptive;
      if (adaptive.ending === 'first_campaign' && firstCampaign) {
        await say('جهزت لك خطة أول حملة.');
        await sayBox({ id: nid(), from: 'assistant', kind: 'first_campaign', campaign: firstCampaign });
        if (firstCampaign.next === 'open_account') setDock({ kind: 'open_account' });
        else setDock(s.subscriptionActive ? { kind: 'final' } : { kind: 'plan' });
        return true;
      }
      if (adaptive.ending === 'first_campaign' || s.subscriptionActive || !s.plan) return false;
      await say(s.audit ? 'خلصت الفحص.' : 'الفحوصات المجانية لهذا الحساب انستخدمت قبل.');
      const agency = adaptive.ending === 'agency';
      push({
        id: nid(),
        from: 'assistant',
        kind: 'plan',
        plan: s.plan,
        trialEligible: s.trialEligible,
        lead: adaptive.decision,
        firstWhy: adaptive.firstWhy,
        subtitle: agency ? agencyPlanSubtitle(s.plan, adaptive.decision !== null, s.trialEligible) : null,
      });
      if (agency) {
        if (adaptive.agencyQuestions.length > 0) {
          await sayBox({ id: nid(), from: 'assistant', kind: 'agency_questions', questions: adaptive.agencyQuestions });
        }
        if (adaptive.fullManagementCard) {
          await sayBox({ id: nid(), from: 'assistant', kind: 'full_management', email: s.email });
        }
      }
      setDock({ kind: 'plan' });
      return true;
    },
    [push, say, sayBox]
  );

  const showResults = useCallback(
    async (s: SetupState) => {
      setPhase('result');
      setDock({ kind: 'none' });
      if (s.adaptive && (await showAdaptiveEnding(s))) return;
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
    [push, say, showAdaptiveEnding]
  );

  // ------------------------------------------------------------- questions

  /**
   * After «صح، وريني الخطة»: the ending. If the free audit is still running the
   * existing waiting flow takes over first, and the audit watcher shows the
   * ending when it lands.
   */
  const proceedToEnding = useCallback(async () => {
    const s = (await reload()) ?? stateRef.current;
    if (s.adaptive?.auditAllowed && !s.edit && !s.audit) {
      const kind = auditRef.current.status.kind;
      if (kind !== 'done' && kind !== 'exhausted') {
        await say('أعطني لحظة أخلّص فحص حسابك.');
        push({ id: nid(), from: 'assistant', kind: 'audit' });
        waitingForAuditRef.current = true;
        if (kind === 'idle' || kind === 'error') void auditRef.current.retry();
        return;
      }
    }
    await showResults(s);
  }, [push, reload, say, showResults]);

  /** The questions are done: «فهمت عليك» first, the ending only after the customer says it is right. */
  const finishAdaptive = useCallback(async () => {
    const s = (await reload()) ?? stateRef.current;
    const rows = s.adaptive?.understood ?? [];
    if (rows.length === 0) {
      await proceedToEnding();
      return;
    }
    await say('خلصنا. هذا اللي فهمته عنك:');
    await sayBox({ id: nid(), from: 'assistant', kind: 'understood', rows });
    setDock({ kind: 'understood' });
  }, [proceedToEnding, reload, say, sayBox]);

  const confirmUnderstood = useCallback(async () => {
    setDock({ kind: 'none' });
    me('صح، وريني الخطة');
    await proceedToEnding();
  }, [me, proceedToEnding]);

  const finishQuestions = useCallback(async () => {
    const s = stateRef.current;
    if (s.edit && s.adaptive && s.accounts.length === 0) {
      // Going on without an account: there is no /home to go back to. The edit ends where the first run ends, on
      // «فهمت عليك» with the new answers (a fresh /onboarding, so «عدّل شي» works again), and one tap from the plan.
      setPhase('finishing');
      await say('حفظت التعديل.');
      router.replace('/onboarding');
      return;
    }
    if (s.edit) {
      setPhase('result');
      await say('حفظت كل شي. وأي شي يتغير في نشاطك بعدين قله لي بالكلام وأحفظه.');
      setDock({ kind: 'edit_done' });
      return;
    }
    setPhase('finishing');
    if (s.adaptive) {
      await finishAdaptive();
      return;
    }
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
  }, [finishAdaptive, push, reload, router, say, showResults]);

  /**
   * Adaptive: «لحظة، أقرا حسابك.» The one read of the account, at most once per
   * page load. A failed or slow read (12 seconds) is not an error to show: the
   * tree then simply asks more.
   */
  const readAccount = useCallback(
    async (s: SetupState): Promise<SetupState> => {
      readTriedRef.current = true;
      await say('لحظة، أقرا حسابك.');
      if (!alive.current) return s;
      setTyping(true);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      let ok = false;
      try {
        const res = await fetch('/api/setup/signals', { method: 'POST', signal: controller.signal });
        ok = res.ok;
      } catch {
        ok = false;
      } finally {
        clearTimeout(timer);
      }
      if (!alive.current) return s;
      setTyping(false);
      return ok ? ((await reload()) ?? s) : s;
    },
    [reload, say]
  );

  /** Adaptive: the opener, «اللي شفته», and «صح كذا؟». Asked again (the big line only) when the customer goes back to it. */
  const askOpener = useCallback(
    async (opener: Opener) => {
      openerRef.current = opener;
      if (!openerShownRef.current) {
        openerShownRef.current = true;
        await say(opener.greeting);
        if (opener.seen.length > 0) await sayBox({ id: nid(), from: 'assistant', kind: 'seen', rows: opener.seen });
      }
      await say(opener.headline, { big: true, note: opener.ask });
      setDock({ kind: 'confirm', proposal: opener.proposal });
    },
    [say, sayBox]
  );

  const askNext = useCallback(async () => {
    for (;;) {
      const key = queueRef.current.shift();
      if (!key) {
        await finishQuestions();
        return;
      }
      const s = stateRef.current;
      const adaptive = s.adaptive;
      if (adaptive) {
        const opener = key === 'confirm' ? (adaptive.opener ?? openerRef.current) : null;
        const question = adaptive.questions[key] ?? questionBankRef.current[key] ?? null;
        if (opener) {
          setAsked((n) => n + 1);
          askedRef.current.push(key);
          await askOpener(opener);
          return;
        }
        if (question) {
          setAsked((n) => n + 1);
          askedRef.current.push(key);
          await say(question.text, { big: true, note: question.why });
          setDock({ kind: 'question', key, adaptive: question });
          return;
        }
        // An adaptive key the bank wrote no copy for has nothing to ask with: the server plans without it.
        if (isAdaptiveKey(key)) continue;
      }
      setAsked((n) => n + 1);
      askedRef.current.push(key);
      const copy = questionCopy(key, s);
      await say(copy.text, { big: true, note: copy.why });
      setDock({ kind: 'question', key });
      return;
    }
  }, [askOpener, finishQuestions, say]);

  const beginQuestions = useCallback(
    async (input: SetupState, ctx: { accountName?: string | null; hello?: string | null } = {}) => {
      let s = input;
      setPhase('questions');
      let accountLineSaid = false;
      if (s.adaptive?.needsRead && !s.edit && !readTriedRef.current) {
        if (ctx.accountName) {
          await say(`تمام، نبدأ بحساب «${ctx.accountName}».`);
          accountLineSaid = true;
        }
        s = await readAccount(s);
      }
      queueRef.current = [...s.pending];
      historyRef.current = [];
      askedRef.current = [];
      setTotal(Math.max(1, s.pending.length));
      setAsked(0);
      if (s.edit) {
        await say('نعدّل معلومات نشاطك. اختر الجواب الجديد، والحالي عليه علامة.');
      } else {
        if (ctx.accountName && !accountLineSaid) await say(`تمام، نبدأ بحساب «${ctx.accountName}».`);
        if (s.adaptive) {
          // The opener carries its own greeting; without one the plain hello opens the questions.
          if (!s.adaptive.opener && ctx.hello) await say(ctx.hello, { big: true });
          startAudit(s);
        } else {
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
      }
      await askNext();
    },
    [askNext, readAccount, say, startAudit]
  );

  /**
   * After an answer that changes the tree (confirm, type, manager, has_account)
   * the server plans again: the rest of the queue and its count are replaced,
   * and the free audit starts if the new state now allows it.
   */
  const replan = useCallback(
    async (answeredKey: SetupKey) => {
      const next = await reload();
      if (!next) return;
      const queue = replannedQueue({
        pending: next.pending,
        answeredNow: answeredKey,
        asked: askedRef.current,
        edit: next.edit,
      });
      queueRef.current = queue;
      setTotal(Math.max(1, askedCountRef.current + queue.length));
      startAudit(next);
    },
    [reload, startAudit]
  );

  const submitAnswer = useCallback(
    async (key: SetupKey, payload: AnswerPayload) => {
      if (busy) return;
      const restore = dockRef.current;
      setBusy(true);
      setDock({ kind: 'none' });
      const bubble = me(payload.label);
      const adaptiveRun = stateRef.current.adaptive !== null;
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
          // Only the tree's own keys: a legacy key's bubble keeps what was tapped (the budget's range tiles book a
          // stand-in amount the customer never said).
          if (adaptiveRun && isAdaptiveKey(key) && typeof data.label === 'string' && data.label.trim() && data.label.trim() !== payload.label) {
            relabel(bubble, data.label.trim());
          }
          if (data.reaction) await say(String(data.reaction));
          if (adaptiveRun) {
            if (changesTree(key)) await replan(key);
          } else if (key === 'type' && !stateRef.current.edit && !stateRef.current.audit) {
            void auditRef.current.start();
          }
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
        setDock(restore.kind === 'question' || restore.kind === 'confirm' ? restore : { kind: 'question', key });
      }
    },
    [askNext, busy, me, relabel, replan, say]
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
        startAudit(s);
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
    [askChoose, beginQuestions, finishQuestions, say, startAudit]
  );

  /** Adaptive: «كمّل بدون حساب». Records that there is no account yet, then the questions run for a first-campaign plan. */
  const continueWithoutAccount = useCallback(async () => {
    if (busy) return;
    const restore = dockRef.current;
    setBusy(true);
    setDock({ kind: 'none' });
    const bubble = me('كمّل بدون حساب');
    try {
      const res = await fetch('/api/setup/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'has_account', answer: { choice: 'none' } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data.error ?? 'save_failed'));
      if (typeof data.label === 'string' && data.label.trim()) relabel(bubble, data.label.trim());
      await say(data.reaction ? String(data.reaction) : 'تمام، كم سؤال سريع وأجهز لك الخطة.');
      const next = await reload();
      setBusy(false);
      if (!next) throw new Error('reload_failed');
      await continueFrom(next);
    } catch {
      setBusy(false);
      await say('ما انحفظ جوابك. جرّب مرة ثانية.');
      setDock(restore);
    }
  }, [busy, continueFrom, me, relabel, reload, say]);

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
        const hello = `هلا${s.firstName ? ` ${s.firstName}` : ''}، أنا ${ASSISTANT.name}.`;
        if (s.adaptive) {
          // The opener (once the account is read) greets by itself; the hello is only for when there is none.
          await beginQuestions(s, { hello });
          return;
        }
        await say(hello, { big: true });
        await beginQuestions(s);
        return;
      }
      if (s.stage === 'finishing') {
        if (s.adaptive) {
          await say(`هلا${s.firstName ? ` ${s.firstName}` : ''}.`);
          startAudit(s);
        } else {
          await say(`هلا${s.firstName ? ` ${s.firstName}` : ''}. باقي الفحص وأعرض لك النتيجة.`);
          void auditRef.current.start();
        }
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
            {/* Without an account (the adaptive «كمّل بدون حساب») there is no page of theirs to go back to. */}
            {(state.edit || adding) && !(state.adaptive && state.accounts.length === 0) && (
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
              provisioning={provisioning}
              busy={busy}
              canBack={phase === 'questions' && historyRef.current.length > 0}
              onAnswer={submitAnswer}
              onBack={goBack}
              onChoose={chooseAccount}
              onNoAccount={async () => {
                setDock({ kind: 'none' });
                me('ما عندي حساب إعلانات');
                await say(
                  provisioning.available
                    ? 'ولا يهمك. نفتحه لك مجاناً من هنا، أو تفتحه بنفسك بالخطوات وترجع لي.'
                    : 'ولا يهمك. نفتحه لك مجاناً على الواتساب، أو تفتحه بنفسك بالخطوات وترجع لي.'
                );
                setDock({ kind: 'no_account' });
              }}
              onContinueWithoutAccount={continueWithoutAccount}
              onUnderstood={confirmUnderstood}
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
                if (auditPermitted(state)) audit.retry();
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
      return (
        <PlanCard
          id="plan-card"
          plan={line.plan}
          trialEligible={line.trialEligible}
          lead={line.lead}
          firstWhy={line.firstWhy}
          subtitle={line.subtitle}
        />
      );
    case 'seen':
      return <SeenBox rows={line.rows} />;
    case 'understood':
      return <UnderstoodCard rows={line.rows} />;
    case 'first_campaign':
      return <FirstCampaignCard plan={line.campaign} />;
    case 'agency_questions':
      return <AgencyQuestionsCard questions={line.questions} />;
    case 'full_management':
      return <FullManagementCard email={line.email} />;
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
  provisioning,
  busy,
  canBack,
  onAnswer,
  onBack,
  onChoose,
  onNoAccount,
  onContinueWithoutAccount,
  onUnderstood,
  onContinueWithAccounts,
  onAuditRetry,
}: {
  dock: Dock;
  state: SetupState;
  provisioning: ProvisioningInitial;
  busy: boolean;
  canBack: boolean;
  onAnswer: (key: SetupKey, payload: AnswerPayload) => void;
  onBack: (current: SetupKey) => void;
  onChoose: (account: SetupAccount) => void;
  onNoAccount: () => void;
  onContinueWithoutAccount: () => void;
  onUnderstood: () => void;
  onContinueWithAccounts: () => void;
  onAuditRetry: () => void;
}) {
  const adaptive = state.adaptive !== null;
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
          {provisioning.available ? (
            <ProvisionAccountTile email={state.email} initial={provisioning.view} />
          ) : (
            <WhatsAppTile reason="no_ads_account" email={state.email} label="افتحه معي على الواتساب، مجاناً" />
          )}
          {adaptive && <AnswerTile label={CONTINUE_WITHOUT_ACCOUNT} icon="rocket" disabled={busy} onClick={onContinueWithoutAccount} />}
          <Link
            href={NO_ACCOUNT_PATH}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3 text-[15px] font-semibold transition-colors hover:bg-muted"
          >
            أفتحه بنفسي بالخطوات
          </Link>
          <ConnectButton label="فتحته، خلني أربطه" />
        </div>
      );
    case 'open_account':
      // The first-campaign plan of someone with no account: the way to an account, never «كمّل بدون حساب» again.
      return (
        <div className="space-y-2.5">
          {provisioning.available ? (
            <ProvisionAccountTile email={state.email} initial={provisioning.view} />
          ) : (
            <WhatsAppTile reason="no_ads_account" email={state.email} label="افتحه معي على الواتساب، مجاناً" />
          )}
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
          {adaptive && (dock.reason === 'no_ads_account' || dock.reason === 'manager_only') && (
            <AnswerTile label={CONTINUE_WITHOUT_ACCOUNT} icon="rocket" disabled={busy} onClick={onContinueWithoutAccount} />
          )}
        </div>
      );
    case 'choose':
      return <AccountDock accounts={state.accounts} busy={busy} onChoose={onChoose} />;
    case 'question':
      return dock.adaptive ? (
        <AdaptiveDock
          question={dock.adaptive}
          busy={busy}
          canBack={canBack}
          onBack={() => onBack(dock.key)}
          onAnswer={(payload) => onAnswer(dock.key, payload)}
        />
      ) : (
        <QuestionDock
          k={dock.key}
          state={state}
          busy={busy}
          canBack={canBack}
          onBack={() => onBack(dock.key)}
          onAnswer={(payload) => onAnswer(dock.key, payload)}
        />
      );
    case 'confirm':
      return <ConfirmDock proposal={dock.proposal} busy={busy} onAnswer={(payload) => onAnswer('confirm', payload)} />;
    case 'understood':
      return (
        <div className="space-y-1">
          <button
            type="button"
            onClick={onUnderstood}
            className="flex h-14 w-full items-center justify-center rounded-full bg-primary px-5 text-[16px] font-bold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            صح، وريني الخطة
          </button>
          <Link
            href="/onboarding?edit=1"
            prefetch={false}
            className="flex h-12 w-full items-center justify-center rounded-full text-[15px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            عدّل شي
          </Link>
        </div>
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
          {/* The agency ending executes nothing, so the trust line about what «مُضاعِف» changes is left out of it. Every other ending is the plain button. */}
          {state.adaptive?.ending === 'agency' ? (
            <PlanCta trialEligible={state.trialEligible} cta={state.cta} hideTrust />
          ) : (
            <PlanCta trialEligible={state.trialEligible} cta={state.cta} />
          )}
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
