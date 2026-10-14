import type { ScenarioDecision } from '@/lib/setup/adaptive/types';
import { PLAN_COPY, type PaywallCta, type Plan } from './plan';
import { PlanCard, PlanCta } from './plan-paywall';

/**
 * «خطتك جاهزة» as the lock on a screen that would otherwise list the whole
 * plan (the audit, the approvals screen) for someone without access. It is the
 * same card /home shows: the summary and the first decision open, the other
 * decisions as titles only, and the one CTA under them. The locked rows carry
 * only id, title and severity, so their reason, evidence and amounts are never
 * in the page for a person without access.
 */
export function PlanLock({
  plan,
  trialEligible,
  cta,
  suspended = false,
  id,
  lead,
  firstWhy,
}: {
  plan: Plan;
  trialEligible: boolean;
  cta?: PaywallCta;
  suspended?: boolean;
  id?: string;
  /** Adaptive onboarding only: the rules decision shown open in place of the audit's first one (`loadPlanLock` returns it). */
  lead?: ScenarioDecision | null;
  /** Adaptive onboarding only: «ليش أول شي» under the audit's own first decision. */
  firstWhy?: string | null;
}) {
  return (
    <PlanCard plan={plan} trialEligible={trialEligible} id={id ?? 'plan-lock'} lead={lead} firstWhy={firstWhy}>
      <div className="border-t border-border/70 px-4 py-4 sm:px-6">
        {suspended ? (
          <p className="text-center text-[14px] font-semibold leading-7">{PLAN_COPY.suspendedLine}</p>
        ) : (
          <PlanCta trialEligible={trialEligible} cta={cta} />
        )}
      </div>
    </PlanCard>
  );
}
