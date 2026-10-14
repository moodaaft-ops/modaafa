import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/lib/ui/site-chrome';

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
      <SiteHeader />

      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <header className="border-b border-border pb-8">
          <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
          <p className="mt-4 text-base leading-8 text-muted-foreground">{description}</p>
          <p className="mt-3 text-xs text-muted-foreground">آخر تحديث: {updatedAt}</p>
        </header>
        <div className="legal-content py-8">{children}</div>
      </article>

      <SiteFooter />
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
