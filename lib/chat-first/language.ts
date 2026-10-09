import type { ChatLanguageMeta, ChatState } from './contracts';
import { classify } from './orchestrator';
import { understandMessage, type ModelCall, type Understanding } from './understand';

/** Longest message still treated as a plain command by the rules. */
export const SHORT_COMMAND_WORDS = 3;

export type AllowanceCheck = (scope: 'free' | 'subscriber') => Promise<{ allowed: boolean; resetsAt: string | null }>;

/**
 * Decides whether a message needs the model, enforces the per-user server
 * allowance, and never lets a failure close the chat: every failure path
 * returns `understood: null` so the rule planner still answers.
 *
 * Words the rules already handle with certainty never spend a model call.
 */
export async function resolveLanguage(args: {
  message: string;
  state: ChatState;
  hasBackend: boolean;
  call: ModelCall;
  checkAllowance: AllowanceCheck;
}): Promise<{ understood: Understanding | null; meta: ChatLanguageMeta }> {
  const ruled = classify(args.message);
  // Rules are only trusted for short commands. A long free-form sentence that
  // happens to contain a keyword ("ما أعرف من وين أبدا") is exactly what the
  // language layer exists for.
  const words = args.message.trim().split(/\s+/).length;
  if (ruled !== 'ambiguous' && ruled !== 'explain' && words <= SHORT_COMMAND_WORDS) {
    return { understood: null, meta: { source: 'rules' } };
  }
  if (!args.hasBackend) return { understood: null, meta: { source: 'rules', degraded: true } };

  const scope = args.state.subscriptionActive ? 'subscriber' : 'free';
  try {
    const allowance = await args.checkAllowance(scope);
    if (!allowance.allowed) {
      return { understood: null, meta: { source: 'rules', limited: { scope, resetsAt: allowance.resetsAt } } };
    }
  } catch {
    // Allowance storage down: fail closed for the model, keep the chat alive on rules.
    return { understood: null, meta: { source: 'rules', degraded: true } };
  }

  const understood = await understandMessage(args.message, args.state, args.call);
  return understood
    ? { understood, meta: { source: 'model' } }
    : { understood: null, meta: { source: 'rules', degraded: true } };
}
