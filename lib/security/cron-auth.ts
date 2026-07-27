import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { isConfiguredEnv } from '@/lib/platform/env';

export function hasValidCronAuthorization(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!isConfiguredEnv(secret)) return false;

  const expected = Buffer.from(`Bearer ${secret.trim()}`);
  const received = Buffer.from(req.headers.get('authorization') ?? '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
