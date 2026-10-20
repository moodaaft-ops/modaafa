import { UnsafeUrlError, parseCheckableUrl, resolvePublicAddresses, type PublicAddress } from '../landing-check/ssrf';
import { LANDING_USER_AGENT, type FetchDeps } from '../landing-check/fetch';
import { MAX_IMAGE_BYTES } from './requirements';
import { probeImage, type ImageProbe } from './probe';
import { createHash } from 'node:crypto';

/**
 * SSRF-guarded image download. Same rules as the page fetch: https only, every hop
 * is resolved and checked, at most 3 redirects, 6 seconds, 5 MB, no cookies.
 */
export const IMAGE_FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type FetchedImage =
  | { ok: true; url: string; bytes: Uint8Array; sha256: string; probe: ImageProbe }
  | { ok: false; url: string; code: 'unsafe_url' | 'network' | 'timeout' | 'too_many_redirects' | 'not_image' | 'too_large' | 'unreadable' | 'bad_status' };

export async function fetchImage(rawUrl: string, deps: FetchDeps): Promise<FetchedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  const fail = (code: Extract<FetchedImage, { ok: false }>['code']): FetchedImage => ({ ok: false, url: rawUrl, code });
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let url: URL;
      let addresses: PublicAddress[];
      try {
        url = parseCheckableUrl(current);
        addresses = await resolvePublicAddresses(url.hostname, deps.resolve);
      } catch (error) {
        return fail(error instanceof UnsafeUrlError ? 'unsafe_url' : 'network');
      }
      let response: Response;
      try {
        response = await deps.transport({
          url,
          address: addresses[0],
          signal: controller.signal,
          headers: { 'user-agent': LANDING_USER_AGENT, accept: 'image/png,image/jpeg,image/*;q=0.8', 'accept-encoding': 'identity' },
        });
      } catch (error) {
        return fail(controller.signal.aborted ? 'timeout' : 'network');
      }
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) return fail('too_many_redirects');
        try {
          current = new URL(location, url).toString();
        } catch {
          return fail('unsafe_url');
        }
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return fail('bad_status');
      }
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('image/')) {
        await response.body?.cancel().catch(() => undefined);
        return fail('not_image');
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_IMAGE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return fail('too_large');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        const reader = response.body?.getReader();
        if (!reader) return fail('unreadable');
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_IMAGE_BYTES) {
            await reader.cancel().catch(() => undefined);
            return fail('too_large');
          }
          chunks.push(value);
        }
      } catch {
        return fail(controller.signal.aborted ? 'timeout' : 'network');
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const probe = probeImage(bytes);
      if (!probe) return fail('unreadable');
      return { ok: true, url: url.toString(), bytes, sha256: createHash('sha256').update(bytes).digest('hex'), probe };
    }
    return fail('too_many_redirects');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
