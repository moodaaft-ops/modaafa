import { createHash } from 'node:crypto';

import {
  CHUNK_MAX_TOKENS,
  CHUNK_MIN_TOKENS,
  PLAYBOOK_ID_PATTERN,
  SUMMARY_MAX_CHARS,
  estimateTokens,
  type PlaybookChunk,
} from './types';

/**
 * Pure build steps for the Jarvis playbook: sanitize the source markdown,
 * split it into retrievable chunks, and describe each chunk. No file system,
 * no network: scripts/jarvis/build-playbook.ts is the thin CLI around this.
 *
 * The knowledge base itself is private and must never reach the public repo.
 * This module therefore contains only rules and patterns, not knowledge.
 */

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const NOT_AFTER_LETTER = '(?<![\\p{L}\\p{N}])';
const NOT_BEFORE_LETTER = '(?![\\p{L}\\p{N}])';
// Arabic clitics that glue onto a word: و ف ب ل ك, then the definite article.
const AR_CLITICS = '[وفبلك]{0,2}(?:ال)?';

function arabicWord(stem: string) {
  return new RegExp(`${NOT_AFTER_LETTER}${AR_CLITICS}(?:${stem})${NOT_BEFORE_LETTER}`, 'u');
}

type DeniedTerm = { label: string; pattern: RegExp };

/**
 * Anything that identifies the owner, his machine, his tooling or his accounts.
 * A line containing one of these never reaches a chunk, and the import script
 * refuses a file in which one is still present.
 */
export const DENIED_TERMS: ReadonlyArray<DeniedTerm> = [
  { label: 'owner name (ar)', pattern: arabicWord('[أاإآ]يمن') },
  { label: 'owner name (en)', pattern: /\ba[iy]man\b/i },
  { label: 'Mac (ar)', pattern: arabicWord('ماك') },
  { label: 'Mac (en)', pattern: /\bmac(?:os|book)?\b/i },
  { label: 'Chrome (ar)', pattern: arabicWord('كروم(?:ات)?') },
  { label: 'Chrome (en)', pattern: /\bchrome\b/i },
  { label: 'browser profile', pattern: /برو(?:فا|في)يل/u },
  { label: 'MCC', pattern: /\bMCC\b/i },
  // Google Ads customer ids: 123-456-7890 or ten digits in a row.
  { label: 'account number', pattern: /(?<!\d)\d{3}-\d{3}-\d{4}(?!\d)|(?<!\d)\d{10}(?!\d)/ },
  { label: 'file path', pattern: /(?:^|[\s(`'"=])~\/|\/Users\// },
  { label: 'Codex', pattern: /codex/i },
  { label: 'Pipeboard', pattern: /pipeboard/i },
  // The agency's own name (with its short vowel mark), not the plain word for doubling.
  { label: 'agency name', pattern: /مُضاعفة/u },
];

/** Labels of every denied term found in the text (empty when clean). */
export function findDeniedTerms(text: string): string[] {
  const found: string[] = [];
  for (const { label, pattern } of DENIED_TERMS) {
    if (pattern.test(text)) found.push(label);
  }
  return found;
}

/** Pointers back into the source skill that mean nothing once it is chunked. */
const POINTER_LINE = /google-ads-titan|SKILL\.md|(?:^|[\s`(])(?:references|sources)\/|`[\w./-]+\.md`/i;

/** Sections of the source skill about the owner's tooling and model choices. */
const DROPPED_HEADINGS: ReadonlyArray<RegExp> = [
  /طبقة\s+التنفيذ/u,
  /ال?مودل(?:ات)?\s+المناسب/u,
  /جدول\s+المودلات/u,
  /tool\s+layer/i,
  /model\s+(?:table|selection|routing)/i,
];

/** Rewrites that keep a useful sentence instead of dropping it. */
const REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/موافقة\s+(?:ال)?[أاإ]يمن/gu, 'موافقة العميل'],
  // The skill talks to the owner; on the platform the person asking is the customer.
  [/(نبّه|نبه)\s+(?:ال)?[أاإ]يمن/gu, '$1 العميل'],
  [/(وضّح|وضح|قلها|قله|قل|بلّغ|بلغ)\s+ل(?:ـ)?(?:ال)?[أاإ]يمن/gu, '$1 للعميل'],
  [/،\s*والحكم في `[^`]+`/gu, ''],
  [/حسابات\s+عملاء\s+مُضاعفة/gu, 'حسابات عملاء المنصة'],
  [/عملاء\s+مُضاعفة/gu, 'عملاء المنصة'],
  [/(و?)حسابات\s+مُضاعفة\s+المشابهة/gu, '$1حسابات مشابهة'],
];

export type SanitizeStats = {
  /** Lines dropped for a denied term. */
  deniedLines: number;
  /** Lines dropped because they only point back into the source skill. */
  pointerLines: number;
  /** Lines dropped with a whole removed section. */
  sectionLines: number;
};

export type SanitizeResult = {
  text: string;
  removed: SanitizeStats;
  removedLines: number;
  /** Lines kept but reworded by a rewrite rule. */
  rewrittenLines: number;
};

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;

function indentOf(line: string) {
  return line.length - line.trimStart().length;
}

/**
 * Remove owner-specific content from skill markdown. Order matters: rewrites
 * first (so «موافقة أيمن» becomes «موافقة العميل» instead of being dropped),
 * then whole sections, then single lines.
 */
export function sanitizeMarkdown(markdown: string): SanitizeResult {
  const removed: SanitizeStats = { deniedLines: 0, pointerLines: 0, sectionLines: 0 };
  const out: string[] = [];
  let inFence = false;
  let skipSectionLevel: number | null = null;
  let skipItemIndent: number | null = null;
  let rewrittenLines = 0;

  for (const original of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    let line = original;
    for (const [pattern, replacement] of REWRITES) line = line.replace(pattern, replacement);
    const reworded = line !== original;

    const isFence = FENCE.test(line);
    const heading = inFence || isFence ? null : HEADING.exec(line);
    if (isFence) inFence = !inFence;

    if (skipSectionLevel !== null) {
      if (heading && heading[1].length <= skipSectionLevel) {
        skipSectionLevel = null;
      } else {
        removed.sectionLines += 1;
        continue;
      }
    }

    if (heading) {
      skipItemIndent = null;
      const title = heading[2];
      if (DROPPED_HEADINGS.some((p) => p.test(title)) || findDeniedTerms(title).length > 0) {
        skipSectionLevel = heading[1].length;
        removed.sectionLines += 1;
        continue;
      }
    }

    if (skipItemIndent !== null) {
      if (line.trim() !== '' && indentOf(line) > skipItemIndent && !heading) {
        // Continuation or nested bullet of an item that was just dropped.
        removed.deniedLines += 1;
        continue;
      }
      skipItemIndent = null;
    }

    // A fence delimiter is never dropped, or the block would swallow what follows.
    if (!isFence) {
      const denied = findDeniedTerms(line).length > 0;
      const pointer = !denied && POINTER_LINE.test(line);
      if (denied || pointer) {
        if (denied) removed.deniedLines += 1;
        else removed.pointerLines += 1;
        const item = LIST_ITEM.exec(line);
        if (item) skipItemIndent = item[1].length;
        continue;
      }
    }

    if (reworded) rewrittenLines += 1;
    out.push(line);
  }

  const text = out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text,
    removed,
    removedLines: removed.deniedLines + removed.pointerLines + removed.sectionLines,
    rewrittenLines,
  };
}

// ---------------------------------------------------------------------------
// Sections and chunks
// ---------------------------------------------------------------------------

export type Part = {
  level: number;
  number: string | null;
  title: string;
  parent: string | null;
  hasBody: boolean;
};

export type Draft = { parts: Part[]; text: string; tokens: number };

export type Section = {
  level: number;
  headingLine: string;
  number: string | null;
  title: string;
  parent: string | null;
  body: string[];
};

function cleanTitle(raw: string) {
  const plain = raw
    .replace(/\*\*|`/g, '')
    .replace(/\s*\(حي\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const numbered = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(plain);
  return numbered ? { number: numbered[1], title: numbered[2].trim() } : { number: null, title: plain };
}

/** Split markdown on # / ## / ### headings. Headings inside code fences are text. */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { level: 0, headingLine: '', number: null, title: '', parent: null, body: [] };
  let parentH2: string | null = null;
  let inFence = false;

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match && match[1].length <= 3) {
      sections.push(current);
      const level = match[1].length;
      const { number, title } = cleanTitle(match[2]);
      if (level === 1) parentH2 = null;
      const parent = level === 3 ? parentH2 : null;
      if (level === 2) parentH2 = title;
      current = { level, headingLine: line.trim(), number, title, parent, body: [] };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function displayTitle(part: Part) {
  return part.level === 3 && !part.number && part.parent ? `${part.parent}: ${part.title}` : part.title;
}

function draftFromSection(section: Section): Draft | null {
  const body = section.body.join('\n').trim();
  const hasBody = body.length > 0;
  // The file's own title line is noise; keep its intro text only if it has any.
  if (section.level === 0 && !hasBody) return null;
  if (section.level === 1 && !hasBody) return null;
  const lines = section.level <= 1 ? [] : [section.headingLine];
  if (hasBody) lines.push('', body);
  const text = lines.join('\n').trim();
  return {
    parts: [
      {
        level: section.level,
        number: section.number,
        title: section.title,
        parent: section.parent,
        hasBody,
      },
    ],
    text,
    tokens: estimateTokens(text),
  };
}

function joinDrafts(a: Draft, b: Draft): Draft {
  const text = `${a.text}\n\n${b.text}`;
  return { parts: [...a.parts, ...b.parts], text, tokens: estimateTokens(text) };
}

const headingOnly = (draft: Draft) => draft.parts.every((p) => !p.hasBody);

/**
 * Merge chunks under `min` tokens with the next one (a heading with no text is
 * always carried forward). A small chunk that cannot go forward without
 * passing `max` joins the previous chunk when that fits, else stays alone.
 */
export function mergeSmallChunks(
  drafts: Draft[],
  min = CHUNK_MIN_TOKENS,
  max = CHUNK_MAX_TOKENS
): Draft[] {
  const out: Draft[] = [];
  let i = 0;
  while (i < drafts.length) {
    let current = drafts[i++];
    // Joining is free when the result fits, or when the neighbour is going to
    // be split anyway (the split then re-balances the pieces).
    while (
      current.tokens < min &&
      i < drafts.length &&
      (headingOnly(current) || current.tokens + drafts[i].tokens <= max || drafts[i].tokens > max)
    ) {
      current = joinDrafts(current, drafts[i++]);
    }
    const previous = out[out.length - 1];
    if (current.tokens < min && previous && (previous.tokens + current.tokens <= max || previous.tokens > max)) {
      out[out.length - 1] = joinDrafts(previous, current);
    } else {
      out.push(current);
    }
  }
  // A trailing heading with nothing under it carries no knowledge.
  return out.filter((draft) => !headingOnly(draft));
}

/** Paragraphs are blank-line separated blocks; fenced code stays in one piece. */
export function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (current.length) paragraphs.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join('\n'));

  // Never strand a heading at the end of a piece: glue it to what follows.
  const glued: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    let paragraph = paragraphs[i];
    while (/^#{1,6}\s[^\n]*$/.test(paragraph) && i + 1 < paragraphs.length) {
      paragraph = `${paragraph}\n\n${paragraphs[++i]}`;
    }
    glued.push(paragraph);
  }
  return glued;
}

type Atom = {
  text: string;
  /** What joins this atom to the previous one inside a piece. */
  separator: string;
  /** For a row of a long table: the header to repeat when a piece starts here. */
  tableHeader?: string;
};

/** A table header is a row followed by a separator row such as |---|---|. */
function tableHeaderOf(lines: string[]): string[] | null {
  if (lines.length > 2 && /^\s*\|/.test(lines[0]) && /^\s*\|?\s*:?-{3,}/.test(lines[1])) {
    return [lines[0], lines[1]];
  }
  return null;
}

function cutLongLine(line: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > maxChars) {
    const space = rest.lastIndexOf(' ', maxChars);
    const cut = space > maxChars / 2 ? space : maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest);
  return parts;
}

/**
 * Break text into pieces that can be packed freely: whole paragraphs, except a
 * paragraph above the limit (a long table or list), which becomes its lines.
 */
function toAtoms(text: string, max: number): Atom[] {
  const atoms: Atom[] = [];
  for (const paragraph of splitParagraphs(text)) {
    if (estimateTokens(paragraph) <= max) {
      atoms.push({ text: paragraph, separator: '\n\n' });
      continue;
    }
    const lines = paragraph.split('\n');
    const header = tableHeaderOf(lines);
    lines.forEach((line, lineIndex) => {
      cutLongLine(line, max * 3).forEach((part, partIndex) => {
        atoms.push({
          text: part,
          separator: partIndex > 0 ? ' ' : lineIndex === 0 ? '\n\n' : '\n',
          tableHeader: header && lineIndex >= header.length ? header.join('\n') : undefined,
        });
      });
    });
  }
  return atoms;
}

/**
 * Split text above `max` tokens at paragraph boundaries into balanced pieces,
 * so the last piece is never a stub. A single oversized table or list is cut
 * between its lines, and the table header is repeated on each later piece.
 */
export function splitOversizedText(text: string, max = CHUNK_MAX_TOKENS): string[] {
  if (estimateTokens(text) <= max) return [text];
  const atoms = toAtoms(text, max);
  const sizes = atoms.map((atom) => estimateTokens(atom.text) + (atom.separator === '\n\n' ? 1 : 0));
  const total = sizes.reduce((sum, n) => sum + n, 0);

  // Fewest pieces that can respect the limit, cut where the pieces come out
  // most even (least sum of squares).
  for (let pieceCount = Math.max(2, Math.ceil(total / max)); pieceCount <= atoms.length; pieceCount++) {
    const cuts = balancedCuts(sizes, pieceCount, max);
    if (!cuts) continue;
    return cuts.map(([from, to]) => {
      const run = atoms.slice(from, to);
      const body = run.map((atom, index) => (index === 0 ? atom.text : `${atom.separator}${atom.text}`)).join('');
      return run[0].tableHeader ? `${run[0].tableHeader}\n${body}` : body;
    });
  }
  return atoms.map((atom) => atom.text);
}

/** Partition sizes into `count` runs, each at most `max`, minimizing the sum of squared run sizes. */
function balancedCuts(sizes: number[], count: number, max: number): Array<[number, number]> | null {
  const n = sizes.length;
  if (count > n) return null;
  const prefix = [0];
  for (const size of sizes) prefix.push(prefix[prefix.length - 1] + size);
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(INF));
  const from: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let i = k; i <= n; i++) {
      for (let p = k - 1; p < i; p++) {
        const run = prefix[i] - prefix[p];
        if (run > max || cost[k - 1][p] === INF) continue;
        const candidate = cost[k - 1][p] + run * run;
        if (candidate < cost[k][i]) {
          cost[k][i] = candidate;
          from[k][i] = p;
        }
      }
    }
  }
  if (cost[count][n] === INF) return null;
  const runs: Array<[number, number]> = [];
  for (let k = count, i = n; k > 0; k--) {
    const p = from[k][i];
    runs.unshift([p, i]);
    i = p;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Ids, tags, summaries
// ---------------------------------------------------------------------------

/** Fixed prefixes for the known source files, so ids stay readable. */
const FILE_PREFIXES: Readonly<Record<string, string>> = {
  'audit-tests-reporting.md': 'aud',
  'bidding-budget.md': 'bid',
  'expert-playbooks.md': 'exp',
  'fresh-facts.md': 'fact',
  'gaql.md': 'gaql',
  'keywords-search-terms.md': 'st',
  'launch.md': 'lch',
  'operations-diagnostics.md': 'ops',
  'pmax-shopping-demandgen.md': 'pmx',
  'policy-suspension.md': 'pol',
  'saudi-market.md': 'ksa',
  'search-mastery.md': 'srch',
  'shopping-mastery.md': 'shop',
  'tracking.md': 'trk',
  'video-demandgen-mastery.md': 'vid',
};

/** Prefix for a file: the fixed one, else initials of its name, kept unique. */
export function prefixForFile(file: string, taken: ReadonlySet<string> = new Set()): string {
  const fixed = FILE_PREFIXES[file];
  if (fixed) {
    if (taken.has(fixed)) throw new Error(`Duplicate playbook prefix ${fixed} for ${file}`);
    return fixed;
  }
  const base = file.replace(/\.md$/i, '').toLowerCase();
  const words = base.split(/[^a-z]+/).filter(Boolean);
  const letters = words.join('');
  const candidates = [
    words.map((w) => w[0]).join(''),
    letters.slice(0, 3),
    letters.slice(0, 4),
    letters.slice(0, 5),
    letters.slice(0, 6),
    // Names with no Latin letters at all (an Arabic file name).
    'pb',
    ...'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => `pb${letter}`),
  ].filter((c) => /^[a-z]{2,6}$/.test(c));
  const prefix = candidates.find((c) => !taken.has(c));
  if (!prefix) throw new Error(`Cannot derive a unique playbook prefix for ${file}`);
  return prefix;
}

export function formatChunkId(prefix: string, ordinal: number): string {
  if (ordinal < 1 || ordinal > 999) throw new Error(`Chunk ordinal out of range: ${ordinal}`);
  const id = `${prefix}-${String(ordinal).padStart(2, '0')}`;
  if (!PLAYBOOK_ID_PATTERN.test(id)) throw new Error(`Invalid playbook chunk id: ${id}`);
  return id;
}

const TAG_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/tcpa|cpa\s+مستهدف|target\s+cpa/i, 'tcpa'],
  [/troas|roas\s+مستهدف|target\s+roas/i, 'troas'],
  [/max(?:imize)?\s+conversion/i, 'max-conversions'],
  [/بيدنق|مزايدة|bidding|smart\s+bidding|سلّم|سلم الاستراتيجيات/i, 'bidding'],
  [/ميزانية|budget/i, 'budget'],
  [/سكيل|scal(?:e|ing)/i, 'scaling'],
  [/تتبع|tracking|قياس|الأهداف|conversion\s+(?:tracking|actions?)/i, 'tracking'],
  [/enhanced\s+conversions/i, 'enhanced-conversions'],
  [/أوفلاين|اوفلاين|offline|crm/i, 'offline-conversions'],
  [/واتساب|whatsapp/i, 'whatsapp'],
  [/اتصال|مكالم/i, 'calls'],
  [/مصطلحات\s+البحث|search\s+terms/i, 'search-terms'],
  [/سلبي|negative/i, 'negative-keywords'],
  [/n-?gram/i, 'ngram'],
  [/براند|brand/i, 'brand'],
  [/quality\s+score|جودة\s+الإعلان/i, 'quality-score'],
  [/ai\s+max/i, 'ai-max'],
  [/pmax|performance\s+max/i, 'pmax'],
  [/shopping|شوبنق/i, 'shopping'],
  [/merchant|ميرشنت/i, 'merchant-center'],
  [arabicWord('فيد'), 'feed'],
  [/\bfeed\b/i, 'feed'],
  [/demand\s+gen/i, 'demand-gen'],
  [/youtube|يوتيوب|فيديو/i, 'youtube'],
  [/\brsa\b|إعلان|أصول|كرييتف|creative/i, 'ads-creative'],
  [/جماهير|audience|lookalike/i, 'audiences'],
  [/مطابقة|match\s+type|broad/i, 'match-types'],
  [/كلمات|keyword/i, 'keywords'],
  [/تعليق|suspension|استئناف/i, 'suspension'],
  [/سياسة|سياسات|policy|misrepresentation/i, 'policy'],
  [/تحقق|verification/i, 'verification'],
  [/تدقيق|audit/i, 'audit'],
  [/تقرير|تقارير|report/i, 'reporting'],
  [/تجربة|تجارب|اختبار|experiment|a\/b/i, 'experiments'],
  [/تشخيص|إنقاذ|هبوط|انهيار|diagnos/i, 'diagnosis'],
  [/سبام|spam|جودة\s+الليد/i, 'lead-quality'],
  [/gaql/i, 'gaql'],
  [/موسم|تقويم|رمضان|season/i, 'seasonality'],
  [/فوترة|billing/i, 'billing'],
  [/impression\s+share|حصة\s+الظهور/i, 'impression-share'],
  [/هيكل|structure/i, 'structure'],
  [/إطلاق|launch|بريف/i, 'launch'],
  [/اقتصاديات|هامش|poas|roas\s+التعادل/i, 'unit-economics'],
  [/تعلم|learning/i, 'learning-phase'],
  [/صفحة\s+الهبوط|landing/i, 'landing-page'],
  [/مدارس|خلاف|محترف/i, 'expert-opinions'],
  [/سعودي|السعودية/i, 'saudi-market'],
];

const FILE_TAGS: Readonly<Record<string, string[]>> = {
  'audit-tests-reporting.md': ['audit'],
  'bidding-budget.md': ['bidding'],
  'expert-playbooks.md': ['expert-opinions'],
  'fresh-facts.md': ['platform-changes'],
  'gaql.md': ['gaql'],
  'keywords-search-terms.md': ['search'],
  'launch.md': ['launch'],
  'operations-diagnostics.md': ['operations'],
  'pmax-shopping-demandgen.md': [],
  'policy-suspension.md': ['policy'],
  'saudi-market.md': ['saudi-market'],
  'search-mastery.md': ['search'],
  'shopping-mastery.md': ['shopping'],
  'tracking.md': ['tracking'],
  'video-demandgen-mastery.md': ['youtube', 'demand-gen'],
};

const MAX_TAGS = 8;

/** Tags come from the chunk's headings, plus a default for its source file. */
export function inferTags(headings: string[], file: string): string[] {
  const text = headings.join(' \n ');
  const tags = new Set<string>(FILE_TAGS[file] ?? []);
  for (const [pattern, tag] of TAG_RULES) {
    if (pattern.test(text)) tags.add(tag);
  }
  return [...tags].slice(0, MAX_TAGS);
}

const CAMPAIGN_ORDER = ['SEARCH', 'PERFORMANCE_MAX', 'SHOPPING', 'DEMAND_GEN', 'VIDEO'] as const;

const CAMPAIGN_RULES: ReadonlyArray<readonly [RegExp, (typeof CAMPAIGN_ORDER)[number]]> = [
  [/البحث|\bsearch\b|\brsa\b|ai\s+max|الكلمات|keyword/i, 'SEARCH'],
  [/pmax|performance\s+max/i, 'PERFORMANCE_MAX'],
  [/shopping|شوبنق|merchant|ميرشنت|\bfeed\b/i, 'SHOPPING'],
  [arabicWord('فيد'), 'SHOPPING'],
  [/demand\s+gen/i, 'DEMAND_GEN'],
  [/youtube|يوتيوب|فيديو|\bvideo\b/i, 'VIDEO'],
];

const FILE_CAMPAIGN_TYPES: Readonly<Record<string, string[]>> = {
  'keywords-search-terms.md': ['SEARCH'],
  'search-mastery.md': ['SEARCH'],
  'shopping-mastery.md': ['SHOPPING', 'PERFORMANCE_MAX'],
  'video-demandgen-mastery.md': ['DEMAND_GEN', 'VIDEO'],
};

export function inferCampaignTypes(headings: string[], file: string): string[] {
  const text = headings.join(' \n ');
  const types = new Set<string>(FILE_CAMPAIGN_TYPES[file] ?? []);
  for (const [pattern, type] of CAMPAIGN_RULES) {
    if (pattern.test(text)) types.add(type);
  }
  return CAMPAIGN_ORDER.filter((type) => types.has(type));
}

/** First sentence of the chunk's own text, trimmed to `max` characters. */
export function placeholderSummary(body: string, fallbackTitle: string, max = SUMMARY_MAX_CHARS): string {
  let inFence = false;
  let collected = '';
  for (const raw of body.split('\n')) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    const trimmed = raw.trim();
    if (inFence || !trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed) || /^\|/.test(trimmed) || /^[-=*_]{3,}$/.test(trimmed)) continue;
    if (/^\(تتمة:/.test(trimmed)) continue;
    const plain = trimmed
      .replace(/^>\s*/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) continue;
    collected = collected ? `${collected} ${plain}` : plain;
    // A lead-in that ends with a colon says nothing alone: take the next line too.
    if (!/[:：]$/.test(plain)) break;
  }
  if (collected) {
    const end = /[.!؟?](?=\s|$)/.exec(collected);
    const sentence = (end ? collected.slice(0, end.index + 1) : collected).replace(/\.+$/, '').trim();
    if (sentence) return fitSummary(sentence, max);
  }
  return fitSummary(fallbackTitle, max);
}

function fitSummary(text: string, max: number) {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(' ', max - 1);
  const cut = space > max / 2 ? space : max - 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Whole-file and whole-playbook builds
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 90;

/** Continuation pieces start with a short pointer line; leave room for it. */
const CONTINUATION_ALLOWANCE_TOKENS = 40;
/** A chunk is volatile when it carries a (حي) mark or sits under a heading that says so. */
const VOLATILE_HEADING = /سريعة\s+التغير/u;

function composeTitle(parts: Part[], fallback: string): string {
  const bodied = parts.filter((p) => p.hasBody);
  const lead = bodied.length ? bodied : parts;
  const unique: Part[] = [];
  for (const part of lead) {
    if (!unique.some((u) => displayTitle(u) === displayTitle(part))) unique.push(part);
  }
  // A section header that only prefixes its own sub-sections adds nothing.
  const trimmed = unique.filter(
    (part) => !unique.some((other) => other !== part && displayTitle(other).startsWith(`${displayTitle(part)}: `))
  );
  const [first, second] = (trimmed.length ? trimmed : unique).slice(0, 2);
  if (!first) return fallback;
  let title: string;
  if (second && first.parent && first.parent === second.parent && first.level === 3 && !first.number && !second.number) {
    title = `${first.parent}: ${first.title} / ${second.title}`;
  } else {
    title = second ? `${displayTitle(first)} / ${displayTitle(second)}` : displayTitle(first);
  }
  const shortened = title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title;
  const label = sectionLabel(lead);
  return label ? `${label} ${shortened}` : shortened;
}

/**
 * The source text points at sections by number ("see 3.6"). Putting the number
 * in the title lets the model follow such a pointer straight to its chunk.
 */
function sectionLabel(lead: Part[]): string {
  const numbered = lead.filter((p) => p.number);
  if (numbered.length === 0) return '';
  const first = numbered[0].number as string;
  const last = numbered[numbered.length - 1].number as string;
  // A sub-section of the first one adds nothing: "1" already covers "1.2".
  return last === first || last.startsWith(`${first}.`) ? first : `${first}-${last}`;
}

export type FileBuildResult = {
  chunks: PlaybookChunk[];
  removed: SanitizeStats;
  removedLines: number;
  rewrittenLines: number;
};

/** Build the chunks of one source file. Sanitizes first, then chunks. */
export function buildFileChunks(
  file: string,
  markdown: string,
  prefix: string,
  limits: { min?: number; max?: number } = {}
): FileBuildResult {
  const min = limits.min ?? CHUNK_MIN_TOKENS;
  const max = limits.max ?? CHUNK_MAX_TOKENS;
  const sanitized = sanitizeMarkdown(markdown);

  const drafts = splitSections(sanitized.text)
    .map(draftFromSection)
    .filter((draft): draft is Draft => draft !== null);
  const merged = mergeSmallChunks(drafts, min, max);

  const chunks: PlaybookChunk[] = [];
  for (const draft of merged) {
    const bodied = draft.parts.filter((p) => p.hasBody);
    const lead = bodied.length ? bodied : draft.parts;
    const baseTitle = composeTitle(draft.parts, file);
    const section = lead[0]?.number ?? null;
    const headingVolatile = draft.parts.some((p) => VOLATILE_HEADING.test(p.title));
    const headings = draft.parts.flatMap((p) => [p.title, p.parent ?? '']).filter(Boolean);
    const tags = inferTags(headings, file);
    const campaignTypes = inferCampaignTypes(headings, file);

    const pieces =
      draft.tokens > max ? splitOversizedText(draft.text, max - CONTINUATION_ALLOWANCE_TOKENS) : [draft.text];
    pieces.forEach((piece, index) => {
      const body = index === 0 ? piece : `(تتمة: ${baseTitle})\n\n${piece}`;
      const title = pieces.length > 1 ? `${baseTitle} (${index + 1}/${pieces.length})` : baseTitle;
      chunks.push({
        id: formatChunkId(prefix, chunks.length + 1),
        file,
        section,
        title_ar: title,
        summary_ar: placeholderSummary(body, baseTitle),
        tags,
        campaign_types: campaignTypes,
        volatile: headingVolatile || body.includes('(حي)'),
        tokens: estimateTokens(body),
        body_ar: body,
      });
    });
  }
  return {
    chunks,
    removed: sanitized.removed,
    removedLines: sanitized.removedLines,
    rewrittenLines: sanitized.rewrittenLines,
  };
}

export type ChunkStats = {
  count: number;
  totalTokens: number;
  minTokens: number;
  maxTokens: number;
  medianTokens: number;
  volatile: number;
};

export function summarizeChunkStats(chunks: ReadonlyArray<Pick<PlaybookChunk, 'tokens' | 'volatile'>>): ChunkStats {
  const sorted = chunks.map((c) => c.tokens).sort((a, b) => a - b);
  const count = sorted.length;
  const mid = Math.floor(count / 2);
  const median = count === 0 ? 0 : count % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return {
    count,
    totalTokens: sorted.reduce((sum, n) => sum + n, 0),
    minTokens: sorted[0] ?? 0,
    maxTokens: sorted[count - 1] ?? 0,
    medianTokens: median,
    volatile: chunks.filter((c) => c.volatile).length,
  };
}

/** Deterministic version label: changes only when ids, titles, summaries or text change. */
export function computePlaybookVersion(chunks: ReadonlyArray<PlaybookChunk>): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) {
    hash.update(JSON.stringify([chunk.id, chunk.title_ar, chunk.summary_ar, chunk.body_ar]));
  }
  return `pb-${hash.digest('hex').slice(0, 10)}`;
}

export type PlaybookBuild = {
  version: string;
  chunks: PlaybookChunk[];
  removed: SanitizeStats;
  removedLines: number;
  rewrittenLines: number;
  stats: ChunkStats;
};

/** Build every source file (sorted by name, so output is deterministic). */
export function buildPlaybook(files: ReadonlyArray<{ name: string; content: string }>): PlaybookBuild {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const taken = new Set<string>();
  const chunks: PlaybookChunk[] = [];
  const removed: SanitizeStats = { deniedLines: 0, pointerLines: 0, sectionLines: 0 };
  let rewrittenLines = 0;

  for (const file of sorted) {
    const prefix = prefixForFile(file.name, taken);
    taken.add(prefix);
    const built = buildFileChunks(file.name, file.content, prefix);
    chunks.push(...built.chunks);
    removed.deniedLines += built.removed.deniedLines;
    removed.pointerLines += built.removed.pointerLines;
    removed.sectionLines += built.removed.sectionLines;
    rewrittenLines += built.rewrittenLines;
  }

  return {
    version: computePlaybookVersion(chunks),
    chunks,
    removed,
    removedLines: removed.deniedLines + removed.pointerLines + removed.sectionLines,
    rewrittenLines,
    stats: summarizeChunkStats(chunks),
  };
}

// ---------------------------------------------------------------------------
// Summary overrides and validation
// ---------------------------------------------------------------------------

export const SUMMARY_OVERRIDE_MAX_CHARS = 160;

export type OverrideResult = { chunks: PlaybookChunk[]; applied: string[]; unknown: string[] };

/**
 * Replace placeholder summaries with better ones from a human or a model.
 * Throws on a malformed entry; ids that match no chunk are reported, not fatal.
 */
export function applySummaryOverrides(
  chunks: ReadonlyArray<PlaybookChunk>,
  overrides: unknown
): OverrideResult {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Summary overrides must be a JSON object mapping chunk id to summary text.');
  }
  const entries = Object.entries(overrides as Record<string, unknown>);
  const known = new Set(chunks.map((c) => c.id));
  const next = new Map<string, string>();
  const unknown: string[] = [];

  for (const [id, value] of entries) {
    if (!PLAYBOOK_ID_PATTERN.test(id)) throw new Error(`Override key is not a chunk id: ${id}`);
    if (typeof value !== 'string') throw new Error(`Override for ${id} must be a string.`);
    const summary = value.replace(/\s+/g, ' ').trim();
    if (!summary) throw new Error(`Override for ${id} is empty.`);
    if (summary.length > SUMMARY_OVERRIDE_MAX_CHARS) {
      throw new Error(`Override for ${id} is ${summary.length} characters; the limit is ${SUMMARY_OVERRIDE_MAX_CHARS}.`);
    }
    const denied = findDeniedTerms(summary);
    if (denied.length) throw new Error(`Override for ${id} contains a denied term (${denied.join(', ')}).`);
    if (!known.has(id)) {
      unknown.push(id);
      continue;
    }
    next.set(id, summary);
  }

  return {
    chunks: chunks.map((chunk) => (next.has(chunk.id) ? { ...chunk, summary_ar: next.get(chunk.id)! } : chunk)),
    applied: [...next.keys()],
    unknown,
  };
}

/** Every problem that should stop an import. Empty array means the file is safe. */
export function validatePlaybookChunks(chunks: unknown): string[] {
  if (!Array.isArray(chunks) || chunks.length === 0) return ['The file has no chunks.'];
  const problems: string[] = [];
  const seen = new Set<string>();
  chunks.forEach((raw, index) => {
    const where = `chunk #${index + 1}`;
    if (raw === null || typeof raw !== 'object') {
      problems.push(`${where} is not an object.`);
      return;
    }
    const chunk = raw as Record<string, unknown>;
    const id = typeof chunk.id === 'string' ? chunk.id : '';
    const label = id || where;
    if (!PLAYBOOK_ID_PATTERN.test(id)) problems.push(`${where} has an invalid id.`);
    if (seen.has(id)) problems.push(`${label} appears twice.`);
    seen.add(id);
    for (const key of ['file', 'title_ar', 'summary_ar', 'body_ar'] as const) {
      if (typeof chunk[key] !== 'string' || !(chunk[key] as string).trim()) problems.push(`${label} has no ${key}.`);
    }
    if (chunk.section !== null && typeof chunk.section !== 'string') problems.push(`${label} has a bad section.`);
    if (typeof chunk.volatile !== 'boolean') problems.push(`${label} has a bad volatile flag.`);
    if (!Number.isInteger(chunk.tokens) || (chunk.tokens as number) <= 0) problems.push(`${label} has a bad token count.`);
    for (const key of ['tags', 'campaign_types'] as const) {
      const list = chunk[key];
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) problems.push(`${label} has bad ${key}.`);
    }
    const everything = [
      id,
      chunk.file,
      chunk.section,
      chunk.title_ar,
      chunk.summary_ar,
      chunk.body_ar,
      ...(Array.isArray(chunk.tags) ? chunk.tags : []),
      ...(Array.isArray(chunk.campaign_types) ? chunk.campaign_types : []),
    ]
      .filter((item): item is string => typeof item === 'string')
      .join('\n');
    const denied = findDeniedTerms(everything);
    if (denied.length) problems.push(`${label} contains a denied term (${denied.join(', ')}).`);
  });
  return problems;
}
