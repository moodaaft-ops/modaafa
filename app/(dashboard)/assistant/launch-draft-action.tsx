'use client';

import { useState } from 'react';
import { LoaderCircle, Rocket } from 'lucide-react';
import { LaunchPlanPreview } from '@/lib/launch/launch-plan-preview';
import {
  LAUNCH_BUTTON_HINT_AR,
  LAUNCH_BUTTON_LABEL_AR,
  requestLaunchProposal,
  type FetchLike,
  type LaunchProposalState,
} from '@/lib/launch/client';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';

/**
 * «ابنِ الحملة موقوفة» under a builder draft. Mobile first: one full width
 * button, one column of text. It only asks the server for a pending card; the
 * campaign is created (paused) after the merchant approves that card in
 * مركز الموافقات. Rendered only when CAMPAIGN_LAUNCH_ENABLED is on.
 */
export function LaunchDraftAction({ sessionId, customerId }: { sessionId: string; customerId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LaunchProposalState | null>(null);

  async function build() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const next = await requestLaunchProposal(fetch as unknown as FetchLike, { sessionId, customerId });
      setResult(next);
    } finally {
      setBusy(false);
    }
  }

  const done = result?.state === 'card';

  return (
    <div className="mt-3 space-y-3" dir="rtl" data-testid="launch-draft-action">
      {!done && (
        <>
          <button
            type="button"
            onClick={build}
            disabled={busy}
            aria-busy={busy}
            className={cn(buttonClasses({ variant: 'primary', size: 'lg' }), 'min-h-11 w-full sm:w-auto')}
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {busy ? 'نجهز البطاقة...' : LAUNCH_BUTTON_LABEL_AR}
          </button>
          <p className="text-xs leading-6 text-muted-foreground">{LAUNCH_BUTTON_HINT_AR}</p>
        </>
      )}

      {result?.state === 'error' && (
        <p role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.08] px-3 py-2 text-xs leading-6 text-danger">
          {result.message}
        </p>
      )}

      {result?.state === 'blocked' && (
        <div role="alert" className="rounded-lg border border-warning/25 bg-warning/[0.08] px-3 py-2 text-xs leading-6 text-warning">
          <div className="font-semibold">قبل ما نبني لازم تعدّل:</div>
          <ul className="mt-1 list-disc space-y-1 pr-4">
            {result.blockers.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {result?.state === 'card' && (
        <div className="rounded-lg border border-primary/25 bg-primary/[0.06] p-3" data-testid="launch-pending-card">
          <div className="text-[13px] font-semibold text-foreground">البطاقة جاهزة وتنتظر موافقتك</div>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            راجع الخطة، ولما توافق تنبني الحملة موقوفة. التشغيل بطاقة ثانية تعتمدها أنت.
          </p>
          <LaunchPlanPreview plan={result.plan} />
          <a href="/optimizer" className={cn(buttonClasses({ variant: 'primary', size: 'md' }), 'mt-3 min-h-11 w-full sm:w-auto')}>
            افتح مركز الموافقات
          </a>
        </div>
      )}
    </div>
  );
}
