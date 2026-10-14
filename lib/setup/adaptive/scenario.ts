import type { ClassifyInput, Scenario } from './types';

/** CONTRACT (part B): pure. The tree's state, kind and evidence from signals and answers. */
export function classifyScenario(input: ClassifyInput): Scenario {
  void input;
  return {
    state: 'active',
    managed: 'none',
    kind: 'general',
    kindConfidence: 'none',
    kindRanking: ['general'],
    platform: null,
    specialty: null,
    outcome: 'unknown',
    evidence: [],
  };
}
