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
  const rawIdentifier = identifier?.trim() || clientIp(req) || 'unknown';
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

function clientIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip') || null;
}
