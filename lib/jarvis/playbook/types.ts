/**
 * Shared shapes and constants for the Jarvis playbook (the Google Ads knowledge
 * base the assistant reads on demand). Kept free of imports so the build
 * script, the import script and the runtime can all use it.
 */

export const PLAYBOOK_TABLE = 'jarvis_playbook_chunks';

/** A chunk id: file prefix, a dash, a 2 or 3 digit counter. Example: bid-05. */
export const PLAYBOOK_ID_PATTERN = /^[a-z]{2,6}-\d{2,3}$/;

/** Target chunk size, in estimated tokens. */
export const CHUNK_MIN_TOKENS = 200;
export const CHUNK_MAX_TOKENS = 900;

/** Longest one-line summary the index carries. */
export const SUMMARY_MAX_CHARS = 120;

export type PlaybookChunk = {
  id: string;
  file: string;
  section: string | null;
  title_ar: string;
  summary_ar: string;
  tags: string[];
  campaign_types: string[];
  volatile: boolean;
  tokens: number;
  body_ar: string;
};

/** The JSON file the build script writes and the import script reads. */
export type PlaybookBuildFile = {
  version: string;
  chunks: PlaybookChunk[];
};

/**
 * Arabic-aware token estimate: Arabic text costs roughly one token per three
 * characters. Deliberately simple and deterministic; it only sizes chunks.
 */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 3) : 0;
}
