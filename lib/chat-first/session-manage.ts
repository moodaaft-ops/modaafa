import { foldArabicSearch, toAsciiDigits } from '@/lib/accounts/search';

/** The longest name a conversation can be given, counted in characters. */
export const CHAT_TITLE_MAX = 80;

/** A conversation is a UUID row; anything else is rejected before it reaches the database. */
export const CHAT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A new name for a conversation: control characters are dropped, runs of
 * whitespace become one space and the ends are trimmed. Returns null for
 * anything that is not a string, ends up empty, or is longer than
 * CHAT_TITLE_MAX characters (counted by code point, so an emoji is one).
 */
export function parseChatTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  if (Array.from(title).length > CHAT_TITLE_MAX) return null;
  return title;
}

function foldTitle(value: string): string {
  return toAsciiDigits(foldArabicSearch(value.trim().toLowerCase()));
}

/** Titles that contain the typed words, forgiving of Arabic spelling variants. */
export function filterChatsByTitle<T extends { title: string }>(chats: T[], query: string): T[] {
  const needle = foldTitle(query);
  if (!needle) return chats;
  return chats.filter((chat) => foldTitle(chat.title).includes(needle));
}

/** The sidebar shows the search box once there are more chats than this. */
export const CHAT_SEARCH_FROM = 8;
