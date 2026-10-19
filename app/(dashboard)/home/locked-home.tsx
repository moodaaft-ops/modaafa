'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { AudioLines, Lock } from 'lucide-react';
import { PLAN_COPY, lockedBarLine, type PaywallCta, type Plan, type PlanSheetReason } from '@/lib/plan/plan';
import type { ScenarioDecision } from '@/lib/setup/adaptive/types';
import {
  PlanCancelLine,
  PlanCard,
  PlanCtaButton,
  PlanSheet,
  PlanTrust,
} from '@/lib/plan/plan-paywall';
import { PLATFORM_GUIDE_AFTER_START_SECONDS } from '@/lib/onboarding/platform-guide';
import { AssistantAvatar } from '@/lib/ui/assistant-avatar';
import { PlatformGuideDialog } from '@/lib/ui/platform-guide';
import { cn } from '@/lib/utils';

/**
 * /home for someone who has not started a subscription or a trial. It is NOT a
 * conversation: there is no chat client here, so nothing on this page can reach
 * the chat or the voice endpoints. The plan is the first message, the
 * composer is a locked bar with the CTA, and the voice button and «اعتمد» open
 * the paywall sheet instead of a call or an approval.
 */
export function LockedHome({
  plan,
  lead,
  firstWhy,
  trialEligible,
  cta,
  suspended,
  greeting,
  voiceEnabled,
  notice,
  auditHref,
  accountLine,
  recentChanges,
}: {
  plan: Plan;
  /** Adaptive onboarding only: the rules decision shown open in place of the audit's first one. */
  lead?: ScenarioDecision | null;
  /** Adaptive onboarding only: «ليش أول شي» under the audit's own first decision. */
  firstWhy?: string | null;
  trialEligible: boolean;
  /** Where the button goes. A stopped subscription points to /billing; absent means the trial checkout. */
  cta?: PaywallCta;
  suspended: boolean;
  greeting: string;
  voiceEnabled: boolean;
  notice?: React.ReactNode;
  /** Set when there is no audit yet and a free one is still available. */
  auditHref?: string | null;
  accountLine?: string | null;
  /** «التغييرات الأخيرة» with «رجّعه»: the undo is never behind the paywall. */
  recentChanges?: React.ReactNode;
}) {
  const [sheet, setSheet] = useState<PlanSheetReason | null>(null);
  const lastReason = useRef<PlanSheetReason>('default');
  if (sheet) lastReason.current = sheet;
  const open = useCallback((reason: PlanSheetReason) => setSheet(reason), []);
  const close = useCallback(() => setSheet(null), []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[768px] space-y-4 px-4 pb-8 pt-6 sm:px-6 lg:pt-10">
          {notice}
          <div className="flex items-start gap-3">
            <div className="hidden w-7 flex-shrink-0 pt-1 sm:block">
              <AssistantAvatar size={28} />
            </div>
            <div className="min-w-0 flex-1 space-y-4">
              <p className="text-[14px] text-muted-foreground">{greeting}</p>
              <PlanCard
                plan={plan}
                lead={lead}
                firstWhy={firstWhy}
                trialEligible={trialEligible}
                onApprove={suspended ? undefined : () => open('approve')}
                onAsk={suspended ? undefined : () => open('chat')}
              >
                {plan.kind === 'no_audit' && auditHref && (
                  <div className="border-t border-border/70 px-4 py-4 sm:px-6">
                    <Link
                      href={auditHref}
                      className="inline-flex h-10 items-center rounded-full border border-border bg-background px-5 text-[14px] font-bold hover:bg-muted"
                    >
                      {PLAN_COPY.runAudit}
                    </Link>
                  </div>
                )}
              </PlanCard>
              {recentChanges}
              {accountLine && <p className="text-[12.5px] text-muted-foreground">{accountLine}</p>}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[768px] flex-shrink-0 px-3 pb-3 sm:px-6 sm:pb-5">
        <div className="rounded-[26px] border border-border bg-card p-2 shadow-[0_8px_28px_-14px_rgba(14,20,38,0.35)]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => open('chat')}
              className={cn(
                'flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full px-3 text-start text-[14px] leading-6 text-muted-foreground transition-colors hover:bg-muted/60'
              )}
            >
              <Lock className="h-4 w-4 flex-shrink-0" aria-hidden />
              <span className="min-w-0">
                {suspended ? 'حسابك موقوف مؤقتاً' : cta?.reason ?? lockedBarLine(trialEligible)}
              </span>
            </button>
            {voiceEnabled && (
              <button
                type="button"
                onClick={() => open('voice')}
                aria-label="مكالمة صوتية"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted"
              >
                <AudioLines className="h-[18px] w-[18px]" aria-hidden />
              </button>
            )}
          </div>
          {!suspended && <PlanCtaButton trialEligible={trialEligible} cta={cta} className="mt-2 h-12 text-[15.5px]" />}
        </div>
        {!suspended && (
          <div className="mt-2 space-y-1 px-2">
            {cta?.kind !== 'billing' && <PlanCancelLine trialEligible={trialEligible} className="text-[11.5px] leading-5" />}
            {cta?.kind !== 'billing' && (
              <PlatformGuideDialog start={PLATFORM_GUIDE_AFTER_START_SECONDS} label="وش يصير بعد ما أبدأ؟" className="pt-1" />
            )}
            <PlanTrust className="text-[11.5px] leading-5" />
          </div>
        )}
      </div>

      <PlanSheet
        open={sheet !== null}
        reason={lastReason.current}
        trialEligible={trialEligible}
        cta={cta}
        suspended={suspended}
        onClose={close}
      />
    </div>
  );
}
