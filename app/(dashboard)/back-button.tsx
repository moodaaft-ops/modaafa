'use client';

import { useRouter } from 'next/navigation';
import { ArrowRight, Home } from 'lucide-react';
import Link from 'next/link';

export function BackButton() {
  const router = useRouter();

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/90 px-6 py-2">
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
      >
        <ArrowRight className="h-4 w-4" />
        رجوع
      </button>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"
      >
        <Home className="h-4 w-4" />
        لوحة التحكم
      </Link>
    </div>
  );
}
