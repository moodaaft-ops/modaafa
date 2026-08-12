import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { isConfiguredEnv } from '@/lib/platform/env';

export function hasValidCronAuthorization(req: NextRequest) {
  return hasValidBearerAuthorization(req, process.env.CRON_SECRET);
}

export function hasValidHealthAuthorization(req: NextRequest) {
  return hasValidBearerAuthorization(req, process.env.HEALTH_SECRET);
}

function hasValidBearerAuthorization(req: NextRequest, secret?: string) {
  if (!isConfiguredEnv(secret)) return false;

  const expected = Buffer.from(`Bearer ${secret.trim()}`);
  const received = Buffer.from(req.headers.get('authorization') ?? '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
