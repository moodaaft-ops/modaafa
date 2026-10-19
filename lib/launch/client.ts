import type { LaunchPlan } from './types';

/**
 * Browser side of the «ابنِ الحملة موقوفة» button. Pure on purpose: the fetch
 * is injected, so the states and the Arabic messages are testable without a
 * DOM. The server route (app/api/launch/propose) builds the plan from the
 * draft stored on the chat session; the browser sends only two ids.
 */

export type LaunchProposalState =
  | { state: 'card'; cardId: string; plan: LaunchPlan }
  | { state: 'blocked'; plan: LaunchPlan | null; blockers: string[] }
  | { state: 'error'; message: string };

export const LAUNCH_BUTTON_LABEL_AR = 'ابنِ الحملة موقوفة';
export const LAUNCH_BUTTON_HINT_AR = 'تنبني موقوفة وما تصرف ريال لين توافق على التشغيل بنفسك.';

const ERROR_MESSAGES_AR: Record<string, string> = {
  not_found: 'بناء الحملة مو مفعّل لحسابك الحين.',
  unauthorized: 'انتهت الجلسة. سجل دخولك وأعد المحاولة.',
  invalid_origin: 'تعذر التحقق من الطلب. حدّث الصفحة وأعد المحاولة.',
  too_many_requests: 'حاولت أكثر من مرة بسرعة. انتظر دقائق وأعد المحاولة.',
  security_service_unavailable: 'تعذر التحقق من الحد الحين. أعد المحاولة بعد شوي.',
  account_not_found: 'ما لقينا الحساب المرتبط. اختره من جديد وأعد المحاولة.',
  draft_not_found: 'ما لقينا المسودة. اطلب من المساعد يجهز مسودة وأعد المحاولة.',
  launch_proposal_failed: 'ما قدرنا نجهز بطاقة البناء. ما تغير شي في حسابك، وأعد المحاولة بعد شوي.',
};

export function launchErrorMessageAr(code: unknown): string {
  return ERROR_MESSAGES_AR[String(code ?? '')] ?? 'صار خلل مؤقت. ما تغير شي في حسابك، وأعد المحاولة بعد شوي.';
}

/** The button shows only with the flag on, a stored draft that has a name, a session and an account. */
export function shouldOfferLaunch(args: {
  enabled: boolean;
  draft: unknown;
  sessionId: string | null | undefined;
  customerId: string | null | undefined;
}): boolean {
  if (!args.enabled) return false;
  if (!args.sessionId || !args.customerId) return false;
  const draft = args.draft;
  return Boolean(draft && typeof draft === 'object' && String((draft as { name?: unknown }).name ?? '').trim());
}

export type FetchLike = (
  input: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export async function requestLaunchProposal(
  fetchImpl: FetchLike,
  args: { sessionId: string; customerId: string }
): Promise<LaunchProposalState> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl('/api/launch/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: args.sessionId, customerId: args.customerId }),
    });
  } catch {
    return { state: 'error', message: 'تعذر الاتصال. تحقق من الإنترنت وأعد المحاولة.' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { state: 'error', message: launchErrorMessageAr(body?.error) };

  const plan: LaunchPlan | null = body?.plan && typeof body.plan === 'object' ? body.plan : null;
  const cardId = typeof body?.card_id === 'string' && body.card_id ? body.card_id : null;
  if (cardId && plan) return { state: 'card', cardId, plan };

  // No card: the plan has blockers the merchant must fix first (budget, region, copy).
  const blockers = Array.isArray(plan?.blockers)
    ? plan!.blockers.map((b: { message_ar?: unknown }) => String(b?.message_ar ?? '')).filter(Boolean)
    : [];
  if (plan && blockers.length > 0) return { state: 'blocked', plan, blockers };
  return { state: 'error', message: launchErrorMessageAr('launch_proposal_failed') };
}
