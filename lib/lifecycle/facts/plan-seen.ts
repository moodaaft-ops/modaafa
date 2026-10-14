import type { SetupState } from '@/lib/setup/load';

/**
 * Is «خطتك جاهزة» what the setup screen shows next for this state?
 *
 * The server sends the setup state to the browser (GET /api/setup/state), and
 * the browser decides what to draw from it. This mirrors that decision for the
 * one case that matters to the email lifecycle: the plan card is on its way to
 * the screen, so the person is about to see their analysis. That is the
 * first_analysis_viewed event, recorded server side.
 *
 *  - not done with the questions yet: no plan card
 *  - a live subscription or trial: the screen shows the results, not the lock
 *  - no plan, or a plan with no audit and no decision («ما جهزت خطتك للحين»):
 *    nothing was analysed, so nothing was viewed
 *  - the adaptive first-campaign ending: that card replaces the plan card
 */
export function planScreenShown(
  state: Pick<SetupState, 'stage' | 'plan' | 'subscriptionActive'> & {
    adaptive?: Pick<NonNullable<SetupState['adaptive']>, 'ending' | 'firstCampaign'> | null;
  }
): boolean {
  if (state.stage !== 'done') return false;
  if (state.subscriptionActive || !state.plan) return false;
  if (state.plan.kind === 'no_audit') return false;
  const adaptive = state.adaptive;
  if (adaptive && adaptive.ending === 'first_campaign' && adaptive.firstCampaign) return false;
  return true;
}
