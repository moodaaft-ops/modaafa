'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw, ArrowRight } from 'lucide-react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error boundary', error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400">
        <AlertTriangle className="h-8 w-8" aria-hidden="true" />
      </div>
      <h1 className="mt-6 text-2xl font-bold text-foreground">حدث خطأ غير متوقع</h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
        تعذر إكمال العملية الآن. جرّب إعادة المحاولة، وإذا استمرت المشكلة فارجع للوحة التحكم أو حاول لاحقاً.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs text-muted-foreground" dir="ltr">
          رمز التتبع: {error.digest}
        </p>
      )}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          إعادة المحاولة
        </button>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 surface-card px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          لوحة التحكم
        </Link>
      </div>
    </main>
  );
}
