import type { AccountSignals, Scenario, ScenarioDecision } from './types';

/**
 * CONTRACT (part B): a first decision the rules can stand behind, or null.
 * call_hours (clinic, services, local) needs signals.hours and the call_hours
 * answer; idle_products (ecommerce) needs signals.products; tracking_setup
 * comes first for no_tracking and tracking_suspect.
 */
export function scenarioDecision(args: {
  scenario: Scenario;
  signals: AccountSignals | null;
  answered: Partial<Record<string, string | null>>;
  currency: string;
}): ScenarioDecision | null {
  void args;
  return null;
}

/** CONTRACT (part B): «ليش أول شي» for an audit decision, tied to what the customer said. Null when there is nothing honest to say. */
export function planReason(args: {
  scenario: Scenario;
  answered: Partial<Record<string, string | null>>;
  labels: Partial<Record<string, string>>;
  decision: { title: string; category: string | null };
}): string | null {
  void args;
  return null;
}
