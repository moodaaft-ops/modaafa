/** Pulls candidate image URLs out of a landing page. Pure: no network. */

export type CandidateSource = 'og' | 'twitter' | 'img' | 'srcset' | 'icon';
export type ImageCandidate = { url: string; source: CandidateSource; alt: string };

export const MAX_CANDIDATES = 24;

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function absolute(raw: string, base: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** The widest entry of a srcset. */
function widest(srcset: string): string | null {
  let best: { url: string; w: number } | null = null;
  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = descriptor?.endsWith('w') ? Number(descriptor.slice(0, -1)) : descriptor?.endsWith('x') ? Number(descriptor.slice(0, -1)) * 1000 : 0;
    if (!best || w > best.w) best = { url, w: Number.isFinite(w) ? w : 0 };
  }
  return best?.url ?? null;
}

export function extractImageCandidates(html: string, baseUrl: string): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined, source: CandidateSource, alt = '') => {
    if (!raw || out.length >= MAX_CANDIDATES) return;
    const url = absolute(raw, baseUrl);
    if (!url || seen.has(url)) return;
    if (!/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url) && source === 'img') {
      // Extensionless URLs (CDNs) are kept; obvious non-images are not.
      if (/\.(svg|ico|css|js|html?)(\?|$)/i.test(url)) return;
    }
    if (/\.svg(\?|$)/i.test(url)) return;
    seen.add(url);
    out.push({ url, source, alt: alt.slice(0, 120) });
  };

  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') add(a.content, 'og');
    else if (key === 'twitter:image' || key === 'twitter:image:src') add(a.content, 'twitter');
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/icon/i.test(a.rel ?? '') && /apple-touch|icon/i.test(a.rel ?? '')) add(a.href, 'icon');
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.srcset) add(widest(a.srcset), 'srcset', a.alt);
    add(a.src ?? a['data-src'], 'img', a.alt);
  }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.srcset) add(widest(a.srcset), 'srcset');
  }
  return out;
}
