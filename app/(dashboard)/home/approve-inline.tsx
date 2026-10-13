'use client';

import { useState } from 'react';

/**
 * «اعتمد» on a decision card asks once more, in one line, what is about to
 * change on the live account before the form goes to the guarded route. The
 * old approval screen showed the change before the execute button; this keeps
 * that promise on the home screen.
 */
export function ApproveInline({
  id,
  intent,
  label,
  change,
}: {
  id: string;
  intent: 'approve_execute' | 'execute';
  label: string;
  /** "نوع التغيير" from the stored payload, never model text. */
  change: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex h-10 items-center bg-primary px-4 text-[14px] font-bold text-primary-foreground"
      >
        {label}
      </button>
    );
  }
  return (
    <form method="post" action="/api/recommendations/action" className="flex w-full flex-wrap items-center gap-2">
      <input type="hidden" name="recommendation_id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="next" value="/home" />
      <p className="w-full text-[13.5px] leading-6">
        {change ? `بيتغيّر في حسابك: ${change}.` : 'بيتغيّر في حسابك اللي مكتوب فوق.'} وتقدر ترجعه خلال 30 يوم.
      </p>
      <button type="submit" className="inline-flex h-10 items-center bg-primary px-4 text-[14px] font-bold text-primary-foreground">
        إيه، نفّذ
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex h-10 items-center border border-border bg-background px-4 text-[14px] font-bold"
      >
        لا، رجوع
      </button>
    </form>
  );
}
