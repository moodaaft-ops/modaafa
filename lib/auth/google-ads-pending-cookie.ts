import type { NextResponse } from 'next/server';

const LEGACY_COOKIE = 'gads_pending_session';
const COUNT_COOKIE = 'gads_pending_session_chunks';
const CHUNK_COOKIE_PREFIX = 'gads_pending_session_';
const CHUNK_SIZE = 2800;
const MAX_CHUNKS = 14;

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 30 * 60,
  path: '/',
};

export function encodePendingSessionCookiePayload(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function readPendingSessionCookie(
  getCookieValue: (name: string) => string | undefined
): string | undefined {
  const legacy = getCookieValue(LEGACY_COOKIE);
  if (legacy) return legacy;

  const count = Number(getCookieValue(COUNT_COOKIE) ?? 0);
  if (!Number.isFinite(count) || count <= 0 || count > MAX_CHUNKS) return undefined;

  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = getCookieValue(`${CHUNK_COOKIE_PREFIX}${index}`);
    if (!chunk) return undefined;
    chunks.push(chunk);
  }

  return chunks.join('');
}

export function setPendingSessionCookie(res: NextResponse, payload: string) {
  clearPendingSessionCookies(res);

  const chunks = payload.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g')) ?? [];
  if (chunks.length === 0 || chunks.length > MAX_CHUNKS) {
    throw new Error('Pending Google Ads OAuth session is too large for cookie fallback.');
  }

  res.cookies.set(COUNT_COOKIE, String(chunks.length), cookieOptions);
  chunks.forEach((chunk, index) => {
    res.cookies.set(`${CHUNK_COOKIE_PREFIX}${index}`, chunk, cookieOptions);
  });
}

export function clearPendingSessionCookies(res: NextResponse) {
  res.cookies.delete(LEGACY_COOKIE);
  res.cookies.delete(COUNT_COOKIE);
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    res.cookies.delete(`${CHUNK_COOKIE_PREFIX}${index}`);
  }
}
