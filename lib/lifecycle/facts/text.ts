/**
 * Small text helpers for the email facts. Pure: no database, no clock.
 */

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Arabic-Indic and Persian digits become Latin ones (brand rule: Latin digits everywhere). */
export function toLatinDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    return String(code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO);
  });
}

/** Zero-width and bidi control characters that sneak into pasted names. */
const INVISIBLE = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g;

export const FIRST_NAME_MAX = 40;
const FIRST_NAME_MIN = 2;

/**
 * The first word of a person's name, for «هلا {firstName}،».
 *
 * - null name, blank name or a first word with no letter in it: null
 * - the first word is cut at whitespace, then edge punctuation (quotes,
 *   commas, a leading emoji) is trimmed
 * - longer than 40 characters, or shorter than 2: null (a one-letter name is
 *   almost always an initial or junk, and the app's own firstNameFrom agrees)
 * - an email address or markup pasted as a name (@, <, >, braces): null
 *
 * Never guesses. A null name makes the renderer greet with «هلا،».
 */
export function firstNameOf(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const first = name.replace(INVISIBLE, ' ').trim().split(/\s+/)[0] ?? '';
  const word = first.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
  if (!word || /[@<>{}\\/]/.test(word) || !/\p{L}/u.test(word)) return null;
  const length = [...word].length;
  if (length < FIRST_NAME_MIN || length > FIRST_NAME_MAX) return null;
  return word;
}

export const HIGHLIGHT_MAX_CHARS = 140;
export const HIGHLIGHT_MAX_LINES = 3;

/**
 * One line of the stored weekly narrative as plain text: markdown and HTML
 * removed, dashes turned into the Arabic comma, Latin digits, whitespace
 * collapsed. A line of 140 characters or more is replaced by its first
 * sentence when that fits; otherwise it is dropped (never cut in the middle:
 * a half sentence in a customer email is worse than a missing line).
 */
export function cleanHighlightLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(INVISIBLE, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/, '');
  text = text.replace(/^\s*(?:[-*+•▪◦·]|\d+[.)])\s+/, '');
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/[*`~]+/g, '');
  text = text.replace(/^\s*>\s?/, '');
  text = text.replace(/\s*[—–]\s*/g, '، ');
  text = toLatinDigits(text).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length < HIGHLIGHT_MAX_CHARS) return text;
  const firstSentence = text.match(/^(.+?[.!؟?])(?=\s|$)/)?.[1]?.trim();
  return firstSentence && firstSentence.length < HIGHLIGHT_MAX_CHARS ? firstSentence : null;
}

/**
 * Up to three highlight lines from a stored weekly report. The narrative's own
 * bullet list comes first; when it has none the summary is split into
 * sentences. A sentence ends at . ! ؟ ? followed by whitespace, so «ر.س» and
 * «1.5» stay whole.
 */
export function highlightsFrom(narrative: { highlights?: unknown; summary?: unknown }): string[] {
  const fromList = Array.isArray(narrative.highlights) ? narrative.highlights : [];
  const summary = typeof narrative.summary === 'string' ? narrative.summary : '';
  const candidates = fromList.length > 0 ? fromList : summary.split(/(?<=[.!؟?])\s+|\n+/);

  const out: string[] = [];
  for (const candidate of candidates) {
    const line = cleanHighlightLine(candidate);
    if (line && !out.includes(line)) out.push(line);
    if (out.length === HIGHLIGHT_MAX_LINES) break;
  }
  // A list whose every line was unusable still has a summary to fall back on.
  if (out.length === 0 && fromList.length > 0 && summary) {
    return highlightsFrom({ summary });
  }
  return out;
}
