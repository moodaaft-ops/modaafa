/**
 * Pure helpers behind the assistant screen: thinking stages, suggested prompts
 * built from the selected account, recommendation links and the shape of the
 * conversation that is kept in the browser across a refresh.
 */

export const THINKING_STAGES = [
  { label: 'نقرأ بيانات الحساب المحفوظة', afterMs: 0 },
  { label: 'نراجع آخر فحص والتوصيات المعلقة', afterMs: 4_000 },
  { label: 'نحلل الأرقام ونكتب الرد', afterMs: 10_000 },
] as const;

export const SLOW_REPLY_AFTER_MS = 35_000;

export function thinkingStageAt(elapsedMs: number) {
  let index = 0;
  THINKING_STAGES.forEach((stage, i) => {
    if (elapsedMs >= stage.afterMs) index = i;
  });
  return {
    index,
    total: THINKING_STAGES.length,
    label: THINKING_STAGES[index].label,
    slow: elapsedMs >= SLOW_REPLY_AFTER_MS,
  };
}

export type SuggestionContext = {
  latestAudit: { healthScore: number | null; estimatedWaste: number | null; ranAt: string | null } | null;
  pendingRecommendations: Array<{ id: string; title: string; severity: string | null }>;
};

export const GENERIC_PROMPTS = [
  'وش أهم توصية أبدأ فيها؟',
  'حلل الصرف آخر 7 أيام',
  'ما الحملات اللي تحتاج إيقاف؟',
  'اقترح كلمات سلبية محتملة',
  'هل أرفع الميزانية أو أوقف الهدر أولاً؟',
  'ابنِ لي مسودة حملة بحث بميزانية 100 ريال يومياً',
];

const SEVERITY_RANK: Record<string, number> = { critical: 0, medium: 1, growth: 2 };
const MAX_TITLE = 70;

function clip(title: string) {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1).trimEnd()}…` : clean;
}

export function sortRecommendationsBySeverity<T extends { severity: string | null }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (SEVERITY_RANK[a.severity ?? ''] ?? 9) - (SEVERITY_RANK[b.severity ?? ''] ?? 9)
  );
}

/**
 * Suggested prompts: specific ones from the account's latest audit and pending
 * recommendations first, topped up with generic ones. Always returns `limit`
 * distinct prompts so the panel never looks empty.
 */
export function buildSuggestedPrompts(context: SuggestionContext | null | undefined, limit = 6): string[] {
  const specific: string[] = [];

  if (context) {
    const pending = sortRecommendationsBySeverity(context.pendingRecommendations).filter((item) => item.title?.trim());
    if (pending[0]) specific.push(`اشرح لي توصية «${clip(pending[0].title)}» وليش تستاهل`);
    if (pending.length > 1) specific.push('رتب لي التوصيات المعلقة من الأهم للأقل');
    if (context.latestAudit) {
      specific.push('وش أبرز ما طلع في آخر فحص للحساب؟');
      if ((context.latestAudit.estimatedWaste ?? 0) > 0) specific.push('من وين جا الهدر في آخر فحص؟');
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const prompt of [...specific, ...GENERIC_PROMPTS]) {
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    result.push(prompt);
    if (result.length >= limit) break;
  }
  return result;
}

/** Link to the exact recommendation card in the approvals page; falls back to the page itself. */
export function recommendationHref(id?: string | null): string {
  const clean = String(id ?? '').trim();
  if (!clean || !/^[A-Za-z0-9_-]{1,64}$/.test(clean)) return '/optimizer';
  return `/optimizer#rec-${clean}`;
}

/* ---------------- conversation kept in the browser ---------------- */

export const STORED_CHAT_VERSION = 1;
export const STORED_CHAT_MAX_ITEMS = 40;
export const STORED_CHAT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredChat<T> = { v: number; savedAt: number; sessionId: string | null; chat: T[] };

export function chatStorageKey(scope: string, customerId: string) {
  return `modaafa:assistant:${STORED_CHAT_VERSION}:${scope}:${customerId}`;
}

export function serializeChat<T extends { role: string; content: string }>(
  chat: T[],
  sessionId: string | null,
  now = Date.now()
): string {
  const payload: StoredChat<T> = {
    v: STORED_CHAT_VERSION,
    savedAt: now,
    sessionId,
    chat: chat.slice(-STORED_CHAT_MAX_ITEMS),
  };
  return JSON.stringify(payload);
}

/** Returns null for anything missing, malformed, from another version or older than a week. */
export function parseStoredChat<T extends { role: string; content: string }>(
  raw: string | null,
  now = Date.now()
): { chat: T[]; sessionId: string | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChat<T>>;
    if (!parsed || parsed.v !== STORED_CHAT_VERSION || !Array.isArray(parsed.chat)) return null;
    if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > STORED_CHAT_MAX_AGE_MS) return null;
    const chat = parsed.chat.filter(
      (item): item is T =>
        Boolean(item) &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string'
    );
    if (!chat.some((item) => item.role === 'user')) return null;
    return { chat, sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null };
  } catch {
    return null;
  }
}
