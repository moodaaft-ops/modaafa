/**
 * Static reading of a landing page's HTML: tags, mobile setup, WhatsApp and
 * phone links, and how well the title and H1 match the ad group's keywords.
 *
 * Limits worth saying out loud: this is the HTML the server sends. A tag that
 * a script injects after load (a store platform's own integration, a tag
 * manager container) is not in it, so a tag that is missing here is "not
 * visible", and tags that may live inside Google Tag Manager are reported as
 * unknown rather than absent.
 */

export type TagState = 'present' | 'absent' | 'unknown_via_gtm';

export type TagReading = { present: boolean; ids: string[] };

export type PageTags = {
  ga4: TagReading;
  googleAds: TagReading;
  gtm: TagReading;
  clarity: TagReading;
  metaPixel: TagReading;
  tiktokPixel: TagReading;
  snapPixel: TagReading;
};

export type PageAnalysis = {
  title: string;
  h1: string;
  viewport: { present: boolean; deviceWidth: boolean };
  lang: string;
  tags: PageTags;
  whatsapp: { links: number; samples: string[] };
  tel: { links: number };
  /** The page links to a Modaafa smart link (/w/<slug>) for WhatsApp. */
  smartLink: boolean;
  bodyText: string;
};

const SMART_LINK_HOSTS = new Set(['ai.modaafa.com', 'modaafa.com', 'www.modaafa.com']);

// ---------------------------------------------------------------------------
// Small HTML helpers (regex on purpose: one pass, no DOM, bounded input)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function stripTags(html: string) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstTagText(html: string, tag: 'title' | 'h1') {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return match ? stripTags(match[1]).slice(0, 300) : '';
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function reading(ids: string[], extraPresent = false): TagReading {
  const list = unique(ids);
  return { present: extraPresent || list.length > 0, ids: list.slice(0, 5) };
}

function matches(html: string, pattern: RegExp, group = 0) {
  return Array.from(html.matchAll(pattern), (m) => m[group]);
}

export function readTags(html: string): PageTags {
  const hasGtag = /googletagmanager\.com\/gtag\/js|\bgtag\s*\(/i.test(html);
  const gtmIds = matches(html, /\bGTM-[A-Z0-9]{4,10}\b/g);
  return {
    ga4: reading(hasGtag ? matches(html, /\bG-[A-Z0-9]{6,12}\b/g) : []),
    googleAds: reading(matches(html, /\bAW-\d{6,12}\b/g)),
    gtm: reading(gtmIds, /googletagmanager\.com\/gtm\.js/i.test(html)),
    clarity: reading(matches(html, /clarity\.ms\/tag\/([a-z0-9]{6,20})/gi, 1), /\bclarity\s*\(\s*["']set["']/i.test(html)),
    metaPixel: reading(
      matches(html, /fbq\s*\(\s*['"]init['"]\s*,\s*['"]?(\d{8,20})/gi, 1),
      /connect\.facebook\.net\/[a-z_]+\/fbevents\.js/i.test(html)
    ),
    tiktokPixel: reading(
      matches(html, /ttq\.load\s*\(\s*['"]([A-Z0-9]{10,30})['"]/g, 1),
      /analytics\.tiktok\.com\/i18n\/pixel/i.test(html)
    ),
    snapPixel: reading(
      matches(html, /snaptr\s*\(\s*['"]init['"]\s*,\s*['"]([0-9a-f-]{20,40})['"]/gi, 1),
      /sc-static\.net\/scevent/i.test(html)
    ),
  };
}

/**
 * The state of one tag as far as the HTML can tell. A tag that is not in the
 * HTML while a Google Tag Manager container is (and the tag could be loaded by
 * it) is unknown, not absent.
 */
export function tagState(tags: PageTags, key: keyof PageTags): TagState {
  if (tags[key].present) return 'present';
  const canLiveInGtm = key !== 'gtm';
  return canLiveInGtm && tags.gtm.present ? 'unknown_via_gtm' : 'absent';
}

function readLinks(html: string) {
  return matches(html, /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi).map((raw) => {
    const value = raw.replace(/^href\s*=\s*/i, '').replace(/^["']|["']$/g, '');
    return decodeEntities(value).trim();
  });
}

function isWhatsAppHref(href: string) {
  return /^(?:https?:)?\/\/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com)\b/i.test(href) || /^whatsapp:\/\//i.test(href);
}

function isSmartLinkHref(href: string) {
  try {
    const url = new URL(href, 'https://placeholder.invalid');
    if (!SMART_LINK_HOSTS.has(url.hostname.toLowerCase())) return false;
    return /^\/w\/[a-z0-9]{6,24}(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function analyzeHtml(html: string): PageAnalysis {
  const head = html;
  const viewportTag = /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.exec(head)?.[0] ?? '';
  const links = readLinks(html);
  const whatsapp = links.filter(isWhatsAppHref);
  const lang = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,10})/i.exec(html)?.[1]?.toLowerCase() ?? '';
  const withoutScripts = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');

  return {
    title: firstTagText(html, 'title'),
    h1: firstTagText(html, 'h1'),
    viewport: { present: viewportTag !== '', deviceWidth: /width\s*=\s*device-width/i.test(viewportTag) },
    lang,
    tags: readTags(html),
    whatsapp: { links: whatsapp.length, samples: whatsapp.slice(0, 2).map((href) => href.slice(0, 120)) },
    tel: { links: links.filter((href) => /^tel:/i.test(href)).length },
    smartLink: links.some(isSmartLinkHref),
    bodyText: stripTags(withoutScripts).slice(0, 4000),
  };
}

// ---------------------------------------------------------------------------
// Message match: does the page speak the words the ad group buys?
// ---------------------------------------------------------------------------

export type KeywordInput = { text: string; weight: number };

export type MessageMatch = {
  /** 0 to 100, weighted by the keywords' clicks. null when there is nothing to compare. */
  score: number | null;
  matched: string[];
  /** Keywords that appear in the page body but not in the title or H1. */
  bodyOnly: string[];
  missing: string[];
};

const STOPWORDS = new Set([
  'في', 'من', 'الي', 'علي', 'عن', 'مع', 'او', 'ان', 'هذا', 'هذه', 'ما', 'لا', 'كم', 'وين', 'افضل', 'ارخص',
  'the', 'in', 'of', 'for', 'to', 'and', 'a', 'near', 'me', 'best', 'cheap', 'with',
]);

export function normalizeArabicWord(word: string) {
  return word
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function tokenize(text: string): string[] {
  return text
    .split(/[\s\p{P}\p{S}]+/u)
    .map(normalizeArabicWord)
    .map((token) => (token.length > 4 && token.startsWith('ال') ? token.slice(2) : token))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function tokenInSet(token: string, set: Set<string>) {
  if (set.has(token)) return true;
  if (token.length < 4) return false;
  for (const candidate of set) {
    if (candidate.length >= 4 && (candidate.startsWith(token) || token.startsWith(candidate))) return true;
  }
  return false;
}

export function messageMatch(keywords: KeywordInput[], title: string, h1: string, bodyText: string): MessageMatch {
  const usable = keywords
    .map((keyword) => ({ text: keyword.text, weight: Math.max(0, Number(keyword.weight) || 0) || 1, tokens: tokenize(keyword.text) }))
    .filter((keyword) => keyword.tokens.length > 0);
  if (usable.length === 0) return { score: null, matched: [], bodyOnly: [], missing: [] };

  const headline = new Set([...tokenize(title), ...tokenize(h1)]);
  const body = new Set(tokenize(bodyText));
  let weighted = 0;
  let total = 0;
  const matched: string[] = [];
  const bodyOnly: string[] = [];
  const missing: string[] = [];

  for (const keyword of usable) {
    const inHeadline = keyword.tokens.filter((token) => tokenInSet(token, headline)).length / keyword.tokens.length;
    weighted += keyword.weight * inHeadline;
    total += keyword.weight;
    if (inHeadline >= 0.99) matched.push(keyword.text);
    else if (keyword.tokens.every((token) => tokenInSet(token, headline) || tokenInSet(token, body))) bodyOnly.push(keyword.text);
    else missing.push(keyword.text);
  }
  return { score: total > 0 ? Math.round((weighted / total) * 100) : null, matched, bodyOnly, missing };
}
