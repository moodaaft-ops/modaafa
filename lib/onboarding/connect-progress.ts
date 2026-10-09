/**
 * Progress model for the background Google Ads connect job.
 *
 * The OAuth callback now exchanges the code, records a `job_runs` row and
 * redirects straight to /onboarding/preparing. Discovery, metadata and the
 * first data read run after the response (Next `after()`), writing their
 * stage into `job_runs.details`. The preparing screen polls a status route
 * that turns the row into the view below with these pure functions.
 *
 * Nothing secret ever goes into `details`: no token, no code, only stage
 * names, counts, customer ids and spend numbers.
 */

export const CONNECT_STAGES = [
  { id: 'discover', label: 'نكتشف حساباتك', hint: 'نسأل Google عن كل حساب تقدر توصل له' },
  { id: 'read', label: 'نقرأ الأسماء والحالات', hint: 'اسم كل حساب وعملته وهل هو شغال' },
  { id: 'sync', label: 'أول تحديث للبيانات', hint: 'صرف آخر 30 يوم لكل حساب' },
] as const;

export type ConnectStageId = (typeof CONNECT_STAGES)[number]['id'];
export type ConnectStageState = 'done' | 'active' | 'pending' | 'failed';

/**
 * The callback's function has maxDuration 300s and `after()` work shares that
 * budget. A row still `running` past this is a killed invocation.
 */
export const CONNECT_TIMEOUT_MS = 320_000;

export const CONNECT_JOB_PREFIX = 'google_ads_connect:';

export function connectJobName(userId: string) {
  return `${CONNECT_JOB_PREFIX}${userId}`;
}

export type ConnectJobDetails = {
  stage?: string;
  error?: string;
  accounts_found?: number;
  linkable?: number;
  /** customer_id → spend over the last 30 days, in the account currency. */
  spend?: Record<string, number | null>;
  next?: string;
  /** When the user consented (oauth_states.created_at); orders competing jobs. */
  consent_at?: string | null;
};

export type ConnectJobSnapshot = {
  status: string;
  started_at: string;
  finished_at?: string | null;
  details?: ConnectJobDetails | null;
};

export type ConnectPhase = 'none' | 'running' | 'done' | 'failed' | 'timed_out';

export type ConnectProgressView = {
  phase: ConnectPhase;
  stages: Array<{ id: ConnectStageId; label: string; hint: string; state: ConnectStageState }>;
  error: string | null;
  next: string | null;
};

const STAGE_IDS = CONNECT_STAGES.map((stage) => stage.id) as ConnectStageId[];

function stageIndex(stage: string | undefined) {
  if (stage === 'done') return STAGE_IDS.length;
  const index = STAGE_IDS.indexOf(stage as ConnectStageId);
  return index === -1 ? 0 : index;
}

export function isConnectJobTimedOut(snapshot: ConnectJobSnapshot, now = Date.now()) {
  if (snapshot.status !== 'running') return false;
  const started = new Date(snapshot.started_at).getTime();
  return Number.isFinite(started) && now - started > CONNECT_TIMEOUT_MS;
}

export function resolveConnectProgress(
  snapshot: ConnectJobSnapshot | null,
  now = Date.now()
): ConnectProgressView {
  if (!snapshot) {
    return {
      phase: 'none',
      stages: CONNECT_STAGES.map((stage) => ({ ...stage, state: 'pending' as const })),
      error: null,
      next: null,
    };
  }

  const details = snapshot.details ?? {};
  const current = stageIndex(details.stage);
  const timedOut = isConnectJobTimedOut(snapshot, now);

  let phase: ConnectPhase;
  if (timedOut) phase = 'timed_out';
  else if (snapshot.status === 'running') phase = 'running';
  else if (snapshot.status === 'success' || snapshot.status === 'partial') phase = 'done';
  else phase = 'failed';

  const stages = CONNECT_STAGES.map((stage, index) => {
    let state: ConnectStageState;
    if (phase === 'done' || index < current) state = 'done';
    else if (index === current) state = phase === 'running' ? 'active' : 'failed';
    else state = 'pending';
    return { ...stage, state };
  });

  return {
    phase,
    stages,
    error: phase === 'timed_out' ? 'timeout' : phase === 'failed' ? details.error ?? 'connect_failed' : null,
    next: phase === 'done' ? safeOnboardingNext(details.next) : null,
  };
}

/**
 * These two errors already have full recovery blocks on the connect page, so
 * the preparing screen hands over to it instead of showing its own message.
 */
export function connectErrorRecoveryHref(error: string | null) {
  if (error === 'no_accounts' || error === 'no_client_accounts') {
    return `/onboarding/connect?error=${error}`;
  }
  return null;
}

export const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  timeout: 'Google تأخر في الرد أكثر من المعتاد ووقفنا التجهيز. اضغط تجديد الربط وغالباً يكمل من المرة الثانية',
  db_error: 'وصلنا لحساباتك لكن ما قدرنا نحفظها عندنا. جرّب تجديد الربط بعد دقيقة',
  connect_failed: 'ما قدرنا نكمل التجهيز مع Google. جرّب تجديد الربط بعد دقيقة',
};

/**
 * Where the user goes once accounts are ready. A returning user whose saved
 * account is still linked goes straight back to the dashboard; anyone with
 * more than one account chooses; a single account needs no choice.
 */
export function nextStepAfterConnect(params: {
  linkableCount: number;
  persistedSelectionStillLinked: boolean;
}) {
  if (params.persistedSelectionStillLinked) return '/dashboard?connected=1';
  if (params.linkableCount > 1) return '/onboarding/choose';
  return '/onboarding/first-audit';
}

const ALLOWED_NEXT = ['/onboarding/choose', '/onboarding/trial', '/onboarding/first-audit', '/dashboard'];

/** The stored `next` is ours, but the client only ever follows an allowlisted path. */
export function safeOnboardingNext(value: string | undefined | null) {
  if (!value) return null;
  const path = value.split('?')[0];
  return ALLOWED_NEXT.includes(path) && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

/** Poll quickly while work is visibly moving, then back off. */
export function connectPollDelayMs(elapsedMs: number) {
  if (elapsedMs < 20_000) return 1_500;
  if (elapsedMs < 90_000) return 3_000;
  return 5_000;
}
