'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import { cn } from '@/lib/utils';
import {
  ACCOUNT_MANAGERS,
  BUSINESS_TYPES,
  SPEND_BANDS,
  type OnboardingAnswers,
} from '@/lib/growth/onboarding-answers';
import { WELCOME_QUESTIONS_COPY as copy } from '@/lib/welcome/copy';

type Draft = Partial<OnboardingAnswers>;

/**
 * Step 1 of 2 on /welcome. Plain radio inputs inside fieldsets, so the keyboard
 * and screen readers work without any extra code. Saves through
 * /api/onboarding/answers, then refreshes the route: the server decides what
 * comes next, this component never navigates on its own.
 */
export function PreconnectQuestions({ initial }: { initial?: Draft }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initial ?? {});
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [showIncomplete, setShowIncomplete] = useState(false);
  const complete = Boolean(draft.businessType && draft.spendBand && draft.accountManager);

  async function post(body: Record<string, unknown>) {
    setState('saving');
    try {
      const res = await fetch('/api/onboarding/answers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The page reads the saved answers on the server, so this is all it takes.
      router.replace('/welcome');
      router.refresh();
    } catch {
      setState('error');
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!complete) {
      setShowIncomplete(true);
      return;
    }
    void post(draft);
  }

  const busy = state === 'saving';

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 space-y-8">
      <Question
        name="businessType"
        legend={copy.businessType.legend}
        why={copy.businessType.why}
        options={BUSINESS_TYPES}
        value={draft.businessType}
        onChange={(value) => setDraft((d) => ({ ...d, businessType: value as OnboardingAnswers['businessType'] }))}
      />
      <Question
        name="spendBand"
        legend={copy.spend.legend}
        why={copy.spend.why}
        options={SPEND_BANDS}
        value={draft.spendBand}
        onChange={(value) => setDraft((d) => ({ ...d, spendBand: value as OnboardingAnswers['spendBand'] }))}
      />
      <Question
        name="accountManager"
        legend={copy.manager.legend}
        why={copy.manager.why}
        options={ACCOUNT_MANAGERS}
        value={draft.accountManager}
        onChange={(value) => setDraft((d) => ({ ...d, accountManager: value as OnboardingAnswers['accountManager'] }))}
      />

      <div>
        <button
          type="submit"
          disabled={busy}
          aria-disabled={!complete}
          className={cn(
            buttonClasses({ variant: 'primary', size: 'lg', block: true }),
            'h-14 text-base',
            !complete && 'opacity-60'
          )}
        >
          {busy && <Loader2 className="h-5 w-5 animate-spin" aria-hidden />}
          {busy ? copy.saving : copy.next}
        </button>

        <p role="status" className="mt-3 min-h-6 text-[13px] leading-6 text-foreground">
          {state === 'error' ? copy.saveFailed : showIncomplete && !complete ? copy.incomplete : ''}
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={() => void post({ skip: true })}
          className="mt-1 inline-flex min-h-11 items-center text-[13px] font-semibold text-foreground underline decoration-border-strong underline-offset-[6px] hover:decoration-foreground"
        >
          {copy.skip}
        </button>

        <p className="mt-5 border-s-2 border-border-strong ps-3 text-[13px] leading-7 text-muted-foreground">{copy.disclosure}</p>
      </div>
    </form>
  );
}

function Question({
  name,
  legend,
  why,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  why: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  value: string | undefined;
  onChange: (key: string) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-[17px] font-bold leading-8 text-foreground">{legend}</legend>
      <p className="mt-1 text-[13px] leading-7 text-muted-foreground">
        <span className="font-semibold text-foreground">ليش نسأل: </span>
        {why}
      </p>
      <div className="mt-3 grid gap-2">
        {options.map((option) => {
          const selected = value === option.key;
          return (
            <label
              key={option.key}
              className={cn(
                'flex min-h-12 cursor-pointer items-center gap-3 border px-4 py-2.5 text-[15px] leading-7 transition-colors',
                'focus-within:ring-2 focus-within:ring-foreground focus-within:ring-offset-2 focus-within:ring-offset-background',
                selected ? 'border-foreground bg-surface font-semibold text-foreground' : 'border-border text-foreground hover:border-border-strong'
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.key}
                checked={selected}
                onChange={() => onChange(option.key)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center border', selected ? 'border-foreground' : 'border-border-strong')}
              >
                {selected && <span className="h-2 w-2 bg-signal ring-1 ring-foreground/40" />}
              </span>
              <span className="min-w-0">{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
