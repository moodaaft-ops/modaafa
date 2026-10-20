import { UnsafeUrlError, parseCheckableUrl, resolvePublicAddresses, type PublicAddress, type Resolver } from './ssrf';

/**
 * Guarded page fetch: SSRF checks on the first URL and on EVERY redirect hop,
 * at most 3 redirects, 5 seconds in total, 1.5 MB of body, no cookies, a
 * custom user agent. The network itself is a dependency (`transport`) so the
 * tests run on a mocked fetch and a mocked DNS resolver.
 */

export const LANDING_USER_AGENT = 'ModaafaLandingCheck/1.0 (+https://ai.modaafa.com)';
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_BODY_BYTES = 1_500_000;

export type TransportRequest = {
  url: URL;
  /** The address the connection must go to (already checked). The real transport pins it. */
  address: PublicAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
};

/** A fetch: gets a checked request, returns a standard Response. Never follows redirects itself. */
export type Transport = (request: TransportRequest) => Promise<Response>;

export type FetchDeps = {
  resolve: Resolver;
  transport: Transport;
  /** Milliseconds, monotonic enough for timings. */
  now?: () => number;
};

export type FetchFailureCode =
  | 'bad_url'
  | 'not_https'
  | 'credentials_in_url'
  | 'bad_port'
  | 'ip_literal'
  | 'blocked_host'
  | 'dns_failed'
  | 'no_address'
  | 'private_address'
  | 'too_many_redirects'
  | 'redirect_without_location'
  | 'timeout'
  | 'network';

export type FetchedPage =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      status: number;
      redirects: string[];
      /** Time from sending the last request until its headers arrived. */
      ttfbMs: number;
      /** Time from the first request until the body was read (redirects included). */
      totalMs: number;
      bytes: number;
      truncated: boolean;
      contentType: string;
      /** null when the response is not an HTML document. */
      html: string | null;
    }
  | { ok: false; requestedUrl: string; code: FetchFailureCode; redirects: string[]; failedUrl: string };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function failure(requestedUrl: string, failedUrl: string, redirects: string[], code: FetchFailureCode): FetchedPage {
  return { ok: false, requestedUrl, failedUrl, redirects, code };
}

export async function guardedFetch(rawUrl: string, deps: FetchDeps): Promise<FetchedPage> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const deadline = startedAt + FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const redirects: string[] = [];
  let current = rawUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let url: URL;
      let addresses: PublicAddress[];
      try {
        url = parseCheckableUrl(current);
        addresses = await resolvePublicAddresses(url.hostname, deps.resolve);
      } catch (error) {
        if (error instanceof UnsafeUrlError) return failure(rawUrl, current, redirects, error.code);
        return failure(rawUrl, current, redirects, 'network');
      }

      const hopStartedAt = now();
      let response: Response;
      try {
        response = await raceDeadline(
          Promise.resolve().then(() => deps.transport({
            url,
            address: addresses[0],
            signal: controller.signal,
            // No Cookie header, ever; identity encoding so the byte cap measures what we read.
            headers: {
              'user-agent': LANDING_USER_AGENT,
              accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
              'accept-language': 'ar-SA,ar;q=0.9,en;q=0.5',
              'accept-encoding': 'identity',
            },
          })),
          deadline - now()
        );
      } catch (error) {
        return failure(rawUrl, current, redirects, error instanceof DeadlineError ? 'timeout' : isAbort(error) ? 'timeout' : 'network');
      }
      const headersAt = now();

      if (REDIRECT_STATUSES.has(response.status)) {
        await discard(response);
        const location = response.headers.get('location');
        if (!location) return failure(rawUrl, current, redirects, 'redirect_without_location');
        if (hop === MAX_REDIRECTS) return failure(rawUrl, current, redirects, 'too_many_redirects');
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          return failure(rawUrl, current, redirects, 'bad_url');
        }
        redirects.push(next);
        current = next;
        continue;
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const isHtml = contentType === '' || contentType.includes('text/html') || contentType.includes('xhtml');
      let bytes = 0;
      let truncated = false;
      let html: string | null = null;
      if (isHtml) {
        let body: { text: string; bytes: number; truncated: boolean };
        try {
          body = await raceDeadline(readCapped(response, contentType), deadline - now());
        } catch (error) {
          return failure(rawUrl, current, redirects, error instanceof DeadlineError || isAbort(error) ? 'timeout' : 'network');
        }
        html = body.text;
        bytes = body.bytes;
        truncated = body.truncated;
      } else {
        await discard(response);
      }

      return {
        ok: true,
        requestedUrl: rawUrl,
        finalUrl: url.toString(),
        status: response.status,
        redirects,
        ttfbMs: Math.max(0, headersAt - hopStartedAt),
        totalMs: Math.max(0, now() - startedAt),
        bytes,
        truncated,
        contentType,
        html,
      };
    }
    return failure(rawUrl, current, redirects, 'too_many_redirects');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

class DeadlineError extends Error {}

function raceDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) {
    promise.catch(() => undefined);
    return Promise.reject(new DeadlineError('deadline'));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError('deadline')), remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function isAbort(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

function charsetOf(contentType: string) {
  const match = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : 'utf-8';
}

async function readCapped(response: Response, contentType: string) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (bytes + value.byteLength > MAX_BODY_BYTES) {
        chunks.push(value.subarray(0, MAX_BODY_BYTES - bytes));
        bytes = MAX_BODY_BYTES;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder(charsetOf(contentType)).decode(merged);
  } catch {
    text = new TextDecoder('utf-8').decode(merged);
  }
  return { text, bytes, truncated };
}
