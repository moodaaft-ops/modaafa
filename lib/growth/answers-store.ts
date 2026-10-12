import { createAdminClient } from '@/lib/supabase/server';
import type { OnboardingAnswers } from './onboarding-answers';

/**
 * Reads and writes public.user_onboarding_answers
 * (db/migrations/20261014_user_onboarding_answers.sql).
 *
 * "unavailable" covers a table that has not been created yet and any read
 * failure. /welcome treats it as "do not ask": a missing migration or a slow
 * database must never put a wall in front of the Google Ads link.
 */

export type AnswersState =
  | { status: 'none' }
  | { status: 'skipped' }
  | { status: 'answered'; answers: OnboardingAnswers }
  | { status: 'unavailable' };

type Row = {
  business_type: string | null;
  spend_band: string | null;
  account_manager: string | null;
  skipped: boolean;
};

export function rowToState(row: Row | null): AnswersState {
  if (!row) return { status: 'none' };
  if (row.skipped) return { status: 'skipped' };
  if (!row.business_type || !row.spend_band || !row.account_manager) return { status: 'none' };
  return {
    status: 'answered',
    answers: {
      businessType: row.business_type as OnboardingAnswers['businessType'],
      spendBand: row.spend_band as OnboardingAnswers['spendBand'],
      accountManager: row.account_manager as OnboardingAnswers['accountManager'],
    },
  };
}

export async function loadAnswers(userId: string, deps: { client?: any } = {}): Promise<AnswersState> {
  try {
    const client = deps.client ?? createAdminClient();
    const { data, error } = await client
      .from('user_onboarding_answers')
      .select('business_type, spend_band, account_manager, skipped')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.warn('[onboarding-answers] read failed', error.code, error.message);
      return { status: 'unavailable' };
    }
    return rowToState(data);
  } catch (error) {
    console.warn('[onboarding-answers] read threw', error);
    return { status: 'unavailable' };
  }
}

export async function saveAnswers(
  userId: string,
  input: { skipped: true } | { skipped: false; answers: OnboardingAnswers },
  deps: { client?: any; now?: () => Date } = {}
): Promise<{ ok: true } | { ok: false }> {
  try {
    const client = deps.client ?? createAdminClient();
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const row = input.skipped
      ? { user_id: userId, business_type: null, spend_band: null, account_manager: null, skipped: true, updated_at: now }
      : {
          user_id: userId,
          business_type: input.answers.businessType,
          spend_band: input.answers.spendBand,
          account_manager: input.answers.accountManager,
          skipped: false,
          updated_at: now,
        };
    const { error } = await client.from('user_onboarding_answers').upsert(row, { onConflict: 'user_id' });
    if (error) {
      console.error('[onboarding-answers] write failed', error.code, error.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.error('[onboarding-answers] write threw', error);
    return { ok: false };
  }
}
