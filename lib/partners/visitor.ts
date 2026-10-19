import { createHash } from 'node:crypto';

/**
 * One opaque id per visitor per day. The address and user agent go in, only a
 * hash comes out, and the day is part of it so the same person cannot be followed
 * from one day to the next.
 */
export function visitorHash(ip: string | null, userAgent: string | null, day: string, salt: string): string {
  return createHash('sha256').update(`${day}|${ip ?? ''}|${(userAgent ?? '').slice(0, 300)}|${salt}`).digest('hex');
}

export function partnerHashSalt(env: Record<string, string | undefined> = process.env): string {
  return env.PARTNER_HASH_SALT || env.CRON_SECRET || 'mudaafa-partners';
}
