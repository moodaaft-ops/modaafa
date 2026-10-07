'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';

type Props = {
  tokenHash: string;
  type: string;
  next: string;
  redirectTo: string;
};

export function ConfirmForm({ tokenHash, type, next, redirectTo }: Props) {
  const [pending, setPending] = useState(false);

  // Coming back with the browser's back button restores this page from the
  // back/forward cache with the button still disabled. Reset it so the person
  // is never stuck on a dead button.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  return (
    <form method="POST" action="/auth/verify" onSubmit={() => setPending(true)}>
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-[0.9375rem] font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}
        {pending ? 'جاري الدخول...' : 'أكمل الدخول'}
      </button>
    </form>
  );
}
