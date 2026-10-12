import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

import { sanitizePromptText } from '../../ai/optimizer-agent';
import { PLAYBOOK_ID_PATTERN, PLAYBOOK_TABLE, estimateTokens } from './types';

/**
 * Runtime side of the Jarvis playbook. The knowledge itself lives in the
 * jarvis_playbook_chunks table (loaded manually, never from this repository).
 * Here: the short always-on rules, the index of what exists, and the read tool.
 */

// ---------------------------------------------------------------------------
// Always-on rules (small enough to sit in the cached part of every prompt)
// ---------------------------------------------------------------------------

export const JARVIS_CORE_RULES_AR = `قواعد ما تنكسر في أي توصية أو تعديل على الحساب:
1. ما يبدأ صرف قبل ما يكون التتبع سليم. لازم تحويل أساسي واحد على الأقل يقيس نتيجة حقيقية، وإلا الخوارزمية تتعلم من إشارة غلط وكل ريال يزيد الغلط.
2. أي هدف (CPA أو ROAS) يطلع من اقتصاديات العميل نفسه: الهامش ونسبة الإغلاق وقيمة الصفقة. ما يطلع من متوسط الأيام الماضية لحاله.
3. أي تعديل مباشر على الحساب يمشي بالترتيب: تأكد إن هذا هو الحساب المقصود، افحص التعديل قبل التنفيذ لو الأداة تسمح، نفّذ، اقرأ القيمة من الحساب بعد التنفيذ، وسجّل القيمة القديمة عشان نقدر نرجع.
4. أربعة أشياء تنتظر موافقة العميل الصريحة قبل التنفيذ: حملة جديدة، رفع الميزانية، تغيير الهدف، وإيقاف حملة شغالة وتجيب نتائج. القراءة والتحليل والمسودات ما تحتاج موافقة.
5. توصيات قوقل الآلية ودرجة التحسين تشخيص ننظر فيه ونحكم عليه، مو أوامر نطبقها.
6. تغيير واحد من نفس النوع على الحملة الواحدة في الأسبوع. لو تغيّرت الميزانية والهدف والهيكل مع بعض ما نعرف وش اللي أثّر، والتعلم يبدأ من جديد.
7. ممنوع فتح حساب جديد عشان نلتف على تعليق. قوقل تعتبره تحايل وتعلّق كل الحسابات المرتبطة.
8. ما نخترع أرقام، وما فيه متوسطات سوق سعودية موثوقة نستشهد فيها. نقارن بتاريخ الحساب نفسه، وإذا ما فيه تاريخ نقول كذا بصراحة.

الثوابت اللي تحكم القرار:
- ROAS التعادل = 1 ÷ هامش الربح. CPA التعادل لليدز = ربح الصفقة × نسبة الإغلاق. أي هدف تحت هالحدين يخسّر العميل.
- سلّم الاستراتيجيات: Max Clicks ثم Max Conversions ثم tCPA بعد 30 تحويل في 30 يوم ثم tROAS. نحرك الهدف أو الميزانية بخطوات من 10 إلى 20% وننتظر دورة تحويل أو أسبوعين بين الخطوة والثانية.
- كل توصية فيها: التغيير بالضبط، الدليل (الرقم والفترة)، الأثر المتوقع بدون وعود بأرقام، الخطر وطريقة الرجوع، وموعد المراجعة.
- القطعة اللي عليها (يتغير) في الفهرس نتحقق منها قبل ما نقولها كحقيقة حالية.`;

/** Appended to a volatile chunk when it is handed to the model. */
export const VOLATILE_NOTE_AR = 'تنبيه: هذي المعلومة تتغير، تأكد منها قبل ما تقولها كحقيقة حالية.';

// ---------------------------------------------------------------------------
// Index of what the playbook contains
// ---------------------------------------------------------------------------

export type PlaybookIndex = {
  /** Version label of the rows the index was built from. Empty when there is no playbook. */
  version: string;
  /** One line per chunk: `id | title | summary`, volatile chunks marked (يتغير). */
  lines: string;
};

type IndexRow = {
  id?: unknown;
  version?: unknown;
  title_ar?: unknown;
  summary_ar?: unknown;
  volatile?: unknown;
};

export const PLAYBOOK_INDEX_TTL_MS = 10 * 60 * 1000;
/** A missing or unreachable playbook is retried sooner, but not on every request. */
const EMPTY_INDEX_TTL_MS = 60 * 1000;
const INDEX_ROW_LIMIT = 1000;

const EMPTY_INDEX: PlaybookIndex = Object.freeze({ version: '', lines: '' });

let cache: { index: PlaybookIndex; expiresAt: number } | null = null;
let inflight: Promise<PlaybookIndex> | null = null;

/** Forget the cached index (tests, or right after an import). */
export function resetPlaybookCache() {
  cache = null;
  inflight = null;
}

function oneLine(value: unknown, max = 300) {
  return sanitizePromptText(typeof value === 'string' ? value : '', max)
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '/')
    .trim();
}

/** bid-2 < bid-10 < bid-100: by prefix, then by number. */
function compareIds(a: string, b: string) {
  const [prefixA, numberA] = a.split('-');
  const [prefixB, numberB] = b.split('-');
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  return Number(numberA) - Number(numberB);
}

/** Build the index from raw rows. Only rows of the most recently written version count. */
export function buildPlaybookIndex(rows: ReadonlyArray<IndexRow>): PlaybookIndex {
  const valid = rows.filter(
    (row) => typeof row.id === 'string' && PLAYBOOK_ID_PATTERN.test(row.id) && typeof row.version === 'string'
  );
  if (valid.length === 0) return EMPTY_INDEX;
  // Rows arrive newest first, so the first row names the current version.
  const version = valid[0].version as string;
  const lines = valid
    .filter((row) => row.version === version)
    .sort((a, b) => compareIds(a.id as string, b.id as string))
    .flatMap((row) => {
      const title = oneLine(row.title_ar);
      if (!title) return [];
      const summary = oneLine(row.summary_ar, 160);
      const mark = row.volatile === true ? ' (يتغير)' : '';
      return [`${row.id} | ${title}${mark} | ${summary}`];
    });
  return lines.length ? { version, lines: lines.join('\n') } : EMPTY_INDEX;
}

async function fetchPlaybookIndex(admin: SupabaseClient): Promise<PlaybookIndex> {
  try {
    const { data, error } = await admin
      .from(PLAYBOOK_TABLE)
      .select('id, version, title_ar, summary_ar, volatile, updated_at')
      .order('updated_at', { ascending: false })
      .limit(INDEX_ROW_LIMIT);
    if (error || !Array.isArray(data)) return EMPTY_INDEX;
    return buildPlaybookIndex(data as IndexRow[]);
  } catch {
    // The assistant works without the playbook; never let it break an answer.
    return EMPTY_INDEX;
  }
}

/**
 * The index of playbook chunks for the cached part of the prompt. Cached in
 * memory for ten minutes. An empty or unreachable table yields an empty index.
 */
export async function loadPlaybookIndex(
  admin: SupabaseClient,
  options: { now?: () => number; force?: boolean } = {}
): Promise<PlaybookIndex> {
  const now = (options.now ?? Date.now)();
  if (!options.force && cache && cache.expiresAt > now) return cache.index;
  if (!options.force && inflight) return inflight;

  const pending = fetchPlaybookIndex(admin).then((index) => {
    const ttl = index.lines ? PLAYBOOK_INDEX_TTL_MS : EMPTY_INDEX_TTL_MS;
    cache = { index, expiresAt: now + ttl };
    return index;
  });
  inflight = pending;
  try {
    return await pending;
  } finally {
    if (inflight === pending) inflight = null;
  }
}

// ---------------------------------------------------------------------------
// Reading chunks
// ---------------------------------------------------------------------------

export type PlaybookChunkRead = {
  id: string;
  title: string;
  volatile: boolean;
  body: string;
  tokens: number;
  /** True when the body was cut to fit the token budget. */
  truncated: boolean;
};

export type PlaybookReadResult = {
  chunks: PlaybookChunkRead[];
  /** Valid ids that matched no row. */
  missing: string[];
  /** Ids that failed validation (shown trimmed and sanitized). */
  rejected: string[];
  /** Valid ids left unread because of the chunk or token limit. */
  omitted: string[];
  /** True when the table could not be read at all. */
  unavailable: boolean;
};

export type PlaybookReadOptions = { maxChunks?: number; maxTokens?: number };

const DEFAULT_MAX_CHUNKS = 2;
const DEFAULT_MAX_TOKENS = 1800;
const HARD_MAX_CHUNKS = 4;
const HARD_MAX_TOKENS = 4000;
/** Below this much budget left, a partial chunk is not worth sending. */
const MIN_USEFUL_TOKENS = 60;
/** No single stored body is trusted to be longer than this. */
const MAX_BODY_CHARS = 8000;
const MAX_REQUESTED_IDS = 20;

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function truncateToTokens(body: string, tokens: number) {
  const maxChars = tokens * 3;
  if (body.length <= maxChars) return body;
  let cut = body.lastIndexOf('\n', maxChars);
  if (cut < maxChars * 0.5) cut = body.lastIndexOf(' ', maxChars);
  if (cut < maxChars * 0.5) cut = maxChars;
  return body.slice(0, cut).trimEnd();
}

type ReadRow = { id?: unknown; title_ar?: unknown; volatile?: unknown; body_ar?: unknown };

/**
 * Read up to `maxChunks` chunks by id, within `maxTokens` in total. Ids come
 * from the model, so they are validated before they touch the database, and
 * the stored text is sanitized again before it goes back into a prompt.
 */
export async function readPlaybook(
  admin: SupabaseClient,
  ids: unknown,
  options: PlaybookReadOptions = {}
): Promise<PlaybookReadResult> {
  const maxChunks = clampInt(options.maxChunks, 1, HARD_MAX_CHUNKS, DEFAULT_MAX_CHUNKS);
  const maxTokens = clampInt(options.maxTokens, 100, HARD_MAX_TOKENS, DEFAULT_MAX_TOKENS);

  const valid: string[] = [];
  const rejected: string[] = [];
  const requested = Array.isArray(ids) ? ids.slice(0, MAX_REQUESTED_IDS) : [];
  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (PLAYBOOK_ID_PATTERN.test(id)) {
      if (!valid.includes(id)) valid.push(id);
    } else {
      const shown = oneLine(typeof raw === 'string' ? raw : '', 24);
      if (shown && !rejected.includes(shown)) rejected.push(shown);
    }
  }

  const selected = valid.slice(0, maxChunks);
  const omitted = valid.slice(maxChunks);
  const result: PlaybookReadResult = { chunks: [], missing: [], rejected, omitted, unavailable: false };
  if (selected.length === 0) return result;

  let rows: ReadRow[] = [];
  try {
    const { data, error } = await admin
      .from(PLAYBOOK_TABLE)
      .select('id, title_ar, volatile, tokens, body_ar')
      .in('id', selected);
    if (error || !Array.isArray(data)) {
      result.unavailable = true;
      result.missing = selected;
      return result;
    }
    rows = data as ReadRow[];
  } catch {
    result.unavailable = true;
    result.missing = selected;
    return result;
  }

  let remaining = maxTokens;
  for (const id of selected) {
    const row = rows.find((candidate) => candidate.id === id);
    const stored = row && typeof row.body_ar === 'string' ? row.body_ar : '';
    if (!row || !stored.trim()) {
      result.missing.push(id);
      continue;
    }
    let body = sanitizePromptText(stored, MAX_BODY_CHARS).trim();
    let truncated = false;
    if (estimateTokens(body) > remaining) {
      if (remaining < MIN_USEFUL_TOKENS) {
        result.omitted.push(id);
        continue;
      }
      body = truncateToTokens(body, remaining);
      truncated = true;
    }
    const tokens = estimateTokens(body);
    remaining -= tokens;
    result.chunks.push({
      id,
      title: oneLine(row.title_ar),
      volatile: row.volatile === true,
      body,
      tokens,
      truncated,
    });
  }
  return result;
}

/** The text of a read_playbook tool result, in the order the model should see it. */
export function formatPlaybookResult(result: PlaybookReadResult): string {
  const parts: string[] = [];
  for (const chunk of result.chunks) {
    const lines = [`[${chunk.id}] ${chunk.title}`];
    if (chunk.volatile) lines.push(VOLATILE_NOTE_AR);
    lines.push('', chunk.body);
    if (chunk.truncated) lines.push('', '(القطعة مقتطعة لحدود الحجم)');
    parts.push(lines.join('\n'));
  }
  const notes: string[] = [];
  if (result.unavailable) notes.push('الكتيّب غير متاح حالياً، كمّل من القواعد الأساسية وقل للعميل إنك ما قدرت تراجع التفاصيل.');
  if (result.missing.length && !result.unavailable) notes.push(`ما لقيت: ${result.missing.join(', ')}`);
  if (result.rejected.length) notes.push(`معرّف غير صالح: ${result.rejected.join(', ')}`);
  if (result.omitted.length) notes.push(`ما انقرت بسبب الحد: ${result.omitted.join(', ')}`);
  if (notes.length) parts.push(notes.join('\n'));
  return parts.join('\n\n---\n\n') || 'ما فيه قطع مطابقة.';
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const READ_PLAYBOOK_TOOL = {
  name: 'read_playbook',
  description:
    'Read chunks of the Google Ads playbook by id. The ids come from the playbook index in the system prompt ' +
    '(format "bid-05"). Call it before advising on bidding, budgets, tracking, campaign structure, diagnosis or ' +
    'policy when the index lists a relevant chunk. Read at most two chunks per call. Chunks marked (يتغير) hold ' +
    'platform facts that change often: tell the customer to verify them instead of stating them as current fact. ' +
    'Returns the chunk text in Arabic.',
  input_schema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string', pattern: '^[a-z]{2,6}-[0-9]{2,3}$' },
        minItems: 1,
        maxItems: 2,
        description: 'Chunk ids from the index, for example ["bid-05", "st-02"].',
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
} satisfies Anthropic.Tool;
