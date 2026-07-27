import Link from 'next/link';
import type { Metadata } from 'next';
import { SearchX, ArrowRight, LayoutDashboard } from 'lucide-react';

export const metadata: Metadata = {
  title: 'الصفحة غير موجودة',
};

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <SearchX className="h-8 w-8" aria-hidden="true" />
      </div>
      <p className="mt-6 text-sm font-semibold text-primary">404</p>
      <h1 className="mt-2 text-2xl font-bold text-foreground">الصفحة غير موجودة</h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
        الرابط الذي فتحته غير صحيح أو تم نقل الصفحة. يمكنك الرجوع للصفحة الرئيسية أو فتح لوحة التحكم مباشرة.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          الصفحة الرئيسية
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 surface-card px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
          لوحة التحكم
        </Link>
      </div>
    </main>
  );
}
