'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { RotateCcw } from 'lucide-react';

/**
 * Error boundary for every dashboard page. It renders inside the shell, so the
 * sidebar, account switcher and navigation stay usable when one page fails.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard page error', error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col px-4 py-16 sm:px-6" role="alert">
      <span className="status-square text-danger" aria-hidden />
      <h1 className="mt-4 font-display text-xl font-semibold text-foreground">تعذر عرض هذه الصفحة</h1>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">
        حدث خطأ أثناء تحميل الصفحة. أعد المحاولة، وإذا تكرر الخطأ ارجع إلى لوحة التحكم أو بدّل الحساب من القائمة الجانبية.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs text-muted-foreground" dir="ltr">
          رمز التتبع: {error.digest}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          إعادة المحاولة
        </button>
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-md border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          لوحة التحكم
        </Link>
      </div>
    </div>
  );
}
