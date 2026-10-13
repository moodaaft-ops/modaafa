import type { SetupKey } from './questions';

/**
 * Where a customer is in the setup conversation. Decided on the server from
 * real rows only, so a refresh, a second device or the Google round trip all
 * land on the same step.
 *
 * - connect: nothing linked yet (or the last link failed).
 * - connecting: Google said yes and the background job is reading accounts.
 * - choose: several accounts and none picked.
 * - questions: «مُضاعِف» still has questions.
 * - finishing: questions done, the first audit has no result yet.
 * - done: the home screen takes over.
 */
export type SetupStage = 'connect' | 'connecting' | 'choose' | 'questions' | 'finishing' | 'done';

export function resolveSetupStage(input: {
  linkedAccounts: number;
  connectRunning: boolean;
  needsChoice: boolean;
  pending: SetupKey[];
  auditExists: boolean;
  edit: boolean;
}): SetupStage {
  if (input.connectRunning) return 'connecting';
  if (input.linkedAccounts === 0) return 'connect';
  if (input.needsChoice) return 'choose';
  if (input.pending.length > 0) return 'questions';
  if (input.edit) return 'done';
  if (!input.auditExists) return 'finishing';
  return 'done';
}

/** Health score in words, for the result bubble. */
export function healthWord(score: number | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 85) return 'ممتاز';
  if (score >= 70) return 'زين';
  if (score >= 50) return 'يحتاج شغل';
  return 'فيه تسريب واضح';
}

/** First name from a Google profile, never an email local part. */
export function firstNameFrom(meta: Record<string, unknown> | null | undefined): string | null {
  const raw = String(meta?.given_name ?? meta?.full_name ?? meta?.name ?? '').trim();
  if (!raw) return null;
  const first = raw.split(/\s+/)[0] ?? '';
  const clean = first.replace(/[<>{}`]/g, '').slice(0, 24);
  return clean.length >= 2 ? clean : null;
}
