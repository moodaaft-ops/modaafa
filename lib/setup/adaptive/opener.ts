import type { AccountSignals, Opener, Scenario } from './types';

/** CONTRACT (part B): the first message after the read. Null when there is nothing worth saying back (no read, new, no_account). */
export function buildOpener(scenario: Scenario, signals: AccountSignals | null, ctx: { firstName: string | null }): Opener | null {
  void scenario;
  void signals;
  void ctx;
  return null;
}
