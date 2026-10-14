import type { SetupKey } from '../questions';
import type { AdaptiveQuestion, QuestionContext, Scenario } from './types';

/**
 * CONTRACT (part B): which questions are left for this scenario, in order.
 * Mixes legacy keys (type, goal, value, budget, regions, manager, pain,
 * website, name, consent) with adaptive ones. Never asks a key whose answer is
 * on record or readable from the account, except in edit mode.
 */
export function adaptivePending(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  consentAnswered: boolean;
  edit: boolean;
  /** False when nothing is linked (no_account): consent and anything needing an account are skipped. */
  hasAccount: boolean;
}): SetupKey[] {
  void args;
  return [];
}

/**
 * CONTRACT (part B): the copy and options for one key in this scenario.
 * Null means the legacy copy and dock are right for it as they are.
 */
export function adaptiveQuestion(key: SetupKey, ctx: QuestionContext): AdaptiveQuestion | null {
  void key;
  void ctx;
  return null;
}
