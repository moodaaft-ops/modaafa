import { appBaseUrl, signValue, verifySignedValue } from './opt-out';

/**
 * Tracked links for lifecycle mail.
 *
 * A button in an email does not point at the app directly. It points at
 * /m/c?u=<user>&k=<template key>&p=<internal path>&s=<signature>, which counts
 * the click on the message_log row and then redirects to the path. The
 * signature covers user, template and path, so the endpoint can only ever
 * redirect to a path that one of our own emails carried: it is not an open
 * redirect, and nobody can mint a link for someone else's account.
 */
const CLICK_PREFIX = 'email_click';
const MAX_PATH_LENGTH = 600;
const TEMPLATE_KEY = /^[A-Za-z0-9_-]{1,80}$/;
const USER_ID = /^[0-9a-f-]{36}$/i;

export const TRACKING_UTM = { source: 'email', medium: 'lifecycle' } as const;

export function isValidTemplateKey(key: unknown): key is string {
  return typeof key === 'string' && TEMPLATE_KEY.test(key);
}

function hasControlOrSpace(value: string) {
  // C0/C1 controls and DEL: browsers strip tabs and newlines inside a URL, so
  // "/\t/evil.com" would turn into "//evil.com". Spaces are refused as well.
  return /[\u0000- \u007f-\u009f]/.test(value);
}

function looksLikeAuthority(value: string) {
  // "//host", "/\host" and any mix of the two slashes reach another origin.
  return /^[/\\]{2}/.test(value) || value.startsWith('/\\');
}

/**
 * A path that stays on our own origin: starts with one "/", no scheme, no host,
 * no backslash, no control characters, also after one round of percent
 * decoding (so "/%2F/evil.com" and "/%5Cevil.com" are refused too).
 */
export function isSafeInternalPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith('/')) return false;

  const forms = [path];
  try {
    forms.push(decodeURIComponent(path));
  } catch {
    return false;
  }
  for (const form of forms) {
    if (hasControlOrSpace(form)) return false;
    if (form.includes('\\')) return false;
    if (looksLikeAuthority(form)) return false;
  }

  try {
    const parsed = new URL(path, 'https://local.modaafa.invalid');
    if (parsed.origin !== 'https://local.modaafa.invalid') return false;
  } catch {
    return false;
  }
  return true;
}

/** The path with the tracking parameters set (existing utm_* on the path are replaced). */
export function withUtm(path: string, templateKey: string): string | null {
  if (!isSafeInternalPath(path) || !isValidTemplateKey(templateKey)) return null;
  const parsed = new URL(path, 'https://local.modaafa.invalid');
  parsed.searchParams.set('utm_source', TRACKING_UTM.source);
  parsed.searchParams.set('utm_medium', TRACKING_UTM.medium);
  parsed.searchParams.set('utm_campaign', templateKey);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function clickPayload(userId: string, templateKey: string, path: string) {
  // The key is restricted to [A-Za-z0-9_-] and the user id to a uuid, so the
  // colon separators are unambiguous; the path comes last and may contain any.
  return `${userId}:${templateKey}:${path}`;
}

/**
 * The link an email button carries. Null when no signing key is configured,
 * when the path is not a safe internal path, or when the ids look wrong.
 */
export function trackedUrl(userId: string, templateKey: string, path: string): string | null {
  if (!USER_ID.test(userId) || !isValidTemplateKey(templateKey) || !isSafeInternalPath(path)) return null;
  const signature = signValue(CLICK_PREFIX, clickPayload(userId, templateKey, path));
  if (!signature) return null;
  const params = new URLSearchParams({ u: userId, k: templateKey, p: path, s: signature });
  return `${appBaseUrl()}/m/c?${params.toString()}`;
}

export type VerifiedClick = {
  userId: string;
  templateKey: string;
  /** Internal path with the utm parameters already applied. */
  target: string;
};

/** Checks the four query parameters of /m/c. Null for anything that does not verify. */
export function verifyTrackedLink(params: {
  u: string | null | undefined;
  k: string | null | undefined;
  p: string | null | undefined;
  s: string | null | undefined;
}): VerifiedClick | null {
  const { u, k, p, s } = params;
  if (!u || !k || !p || !s) return null;
  if (!USER_ID.test(u) || !isValidTemplateKey(k) || !isSafeInternalPath(p)) return null;
  if (!verifySignedValue(CLICK_PREFIX, clickPayload(u, k, p), s)) return null;
  const target = withUtm(p, k);
  if (!target) return null;
  return { userId: u, templateKey: k, target };
}
