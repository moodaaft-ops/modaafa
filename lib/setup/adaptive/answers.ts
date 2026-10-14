import type { AdaptiveAnswer, AdaptiveKey } from './types';

export type AdaptiveParse = { ok: true; answer: AdaptiveAnswer } | { ok: false; error: string };

export type AdaptiveFact = {
  kind: 'goal' | 'margin' | 'constraint' | 'geo' | 'agency' | 'other' | 'product' | 'schedule' | 'capacity';
  fact_ar: string;
  data: Record<string, unknown>;
};

/** CONTRACT (part B): validates against each key's full option catalog (every scenario's ids). */
export function parseAdaptiveAnswer(key: AdaptiveKey, raw: unknown): AdaptiveParse {
  void key;
  void raw;
  return { ok: false, error: 'invalid_key' };
}

/** CONTRACT (part B): the businesses columns (sector, primary_goal only) and the memory fact for one answer. */
export function adaptiveEffects(answer: AdaptiveAnswer): {
  business: Partial<{ sector: string; primary_goal: string }>;
  fact: AdaptiveFact | null;
} {
  return { business: {}, fact: { kind: 'other', fact_ar: answer.choice, data: { setup_key: answer.key, choice: answer.choice } } };
}

/** CONTRACT (part B): what the customer's bubble says. */
export function adaptiveLabel(answer: AdaptiveAnswer): string {
  return answer.choice;
}

/** CONTRACT (part B): the short line «مُضاعِف» says back, or null. */
export function adaptiveReaction(answer: AdaptiveAnswer): string | null {
  void answer;
  return null;
}
