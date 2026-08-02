import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ThemeToggle } from '@/lib/ui/theme-toggle';

export function LegalPage({
  title,
  description,
  updatedAt,
  children,
}: {
  title: string;
  description: string;
  updatedAt: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/logo-mark.svg" alt="مُضاعِف" width={38} height={38} className="h-10 w-10 rounded-lg" />
            <span className="text-[14px] font-semibold">مُضاعِف</span>
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/login" className="text-sm font-semibold text-primary hover:underline dark:text-primary">
              تسجيل الدخول
            </Link>
          </div>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <header className="border-b border-border pb-8">
          <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
          <p className="mt-4 text-base leading-8 text-muted-foreground">{description}</p>
          <p className="mt-3 text-xs text-muted-foreground">آخر تحديث: {updatedAt}</p>
        </header>
        <div className="legal-content py-8">{children}</div>
      </article>

      <footer className="border-t border-border px-4 py-7 text-sm text-muted-foreground sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
          <span>© 2026 مُضاعِف / Modaafa Ads AI</span>
          <nav className="flex flex-wrap gap-4" aria-label="الصفحات القانونية">
            <Link href="/privacy" className="hover:text-foreground">الخصوصية</Link>
            <Link href="/terms" className="hover:text-foreground">الشروط</Link>
            <Link href="/data-deletion" className="hover:text-foreground">حذف البيانات</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-8 text-muted-foreground">{children}</div>
    </section>
  );
}
