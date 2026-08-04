import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
};

export async function checkRateLimit({
  req,
  scope,
  limit,
  windowSeconds,
  identifier,
}: {
  req: NextRequest;
  scope: string;
  limit: number;
  windowSeconds: number;
  identifier?: string | null;
}): Promise<RateLimitResult> {
  const rawIdentifier = identifier?.trim() || resolveClientIp(req) || 'unknown';
  const digest = createHash('sha256').update(rawIdentifier).digest('hex');
  const key = `${scope}:${digest}`;
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error('Rate limit storage unavailable', { scope, error });
    throw new Error('rate_limit_unavailable');
  }

  const row = Array.isArray(data) ? data[0] : data;
  const resetAt = String(row?.reset_at ?? new Date(Date.now() + windowSeconds * 1000).toISOString());
  return {
    allowed: Boolean(row?.allowed),
    remaining: Math.max(0, Number(row?.remaining ?? 0)),
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000)),
  };
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    'Retry-After': String(result.retryAfterSeconds),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': result.resetAt,
  };
}

/**
 * Client IP for rate limiting — only consulted when a limiter has no
 * authenticated identifier (today: the unauthenticated login endpoint).
 *
 * Exported for tests.
 *
 * ORDER MATTERS. The old code took the LEFT-most `x-forwarded-for` entry,
 * which is whatever the caller put in their own header: one attacker rotating
 * that value per request both bypassed the login rate limit entirely and
 * minted a brand-new `rate_limit_windows` row per request — an unauthenticated
 * storage-exhaustion vector. Platform-set headers (`x-vercel-forwarded-for`,
 * `x-real-ip`) cannot be spoofed by the caller on Vercel, and when we must
 * fall back to a forwarded chain we take the RIGHT-most hop — the one appended
 * by the nearest trusted proxy — never the left-most.
 */
export function resolveClientIp(req: { headers: { get(name: string): string | null } }) {
  const platform =
    lastHop(req.headers.get('x-vercel-forwarded-for')) ?? lastHop(req.headers.get('x-real-ip'));
  if (platform) return platform;
  return lastHop(req.headers.get('x-forwarded-for'));
}

function lastHop(value: string | null) {
  if (!value) return null;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}
