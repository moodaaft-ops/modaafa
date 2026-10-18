'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FaqCategory, FaqItem } from '@/lib/faq/data';
import { itemMatches } from '@/lib/faq/search';

/**
 * The list is fully rendered on the server (every answer is in the HTML for
 * crawlers and for people without JavaScript). The search box only hides what
 * does not match, so it can never remove an answer from the page source.
 */

type Props = {
  categories: FaqCategory[];
  hrefs: { noAccount: string; agency: string };
};

export function FaqBrowser({ categories, hrefs }: Props) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  // A shared link like /faq#trial-14-days should land with that answer open.
  useEffect(() => {
    const openFromHash = () => {
      let fromHash = '';
      try {
        fromHash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      } catch {
        return;
      }
      if (fromHash) setOpenId(fromHash);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);

  const visible = useMemo(() => {
    const result = new Set<string>();
    for (const category of categories) {
      for (const item of category.items) {
        if (itemMatches(item, query)) result.add(item.id);
      }
    }
    return result;
  }, [categories, query]);

  const searching = query.trim().length > 0;

  return (
    <div>
      <label className="relative block">
        <span className="sr-only">ابحث في الأسئلة</span>
        <Search
          aria-hidden
          className="pointer-events-none absolute start-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ابحث: السعر، العراق، تطبيق"
          className="h-14 w-full border border-border bg-background ps-12 pe-4 text-[16.5px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground"
        />
      </label>

      <nav aria-label="أقسام الأسئلة" className="mt-5 flex flex-wrap gap-2">
        {categories.map((category) => (
          <a
            key={category.id}
            href={`#cat-${category.id}`}
            className="border border-border px-3.5 py-1.5 text-[14.5px] text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
          >
            {category.title}
          </a>
        ))}
      </nav>

      <p role="status" aria-live="polite" className="mt-6 min-h-6 text-[14.5px] text-muted-foreground">
        {searching && visible.size === 0 ? 'ما لقينا سؤال يطابق كلامك. جرّب كلمة ثانية، أو اسألنا في الواتساب تحت.' : ''}
        {searching && visible.size > 0 ? `${visible.size.toLocaleString('en-US')} سؤال يطابق بحثك` : ''}
      </p>

      <div className="mt-2 space-y-14">
        {categories.map((category) => {
          const shown = category.items.filter((item) => visible.has(item.id));
          return (
            <section
              key={category.id}
              id={`cat-${category.id}`}
              aria-labelledby={`cat-title-${category.id}`}
              hidden={shown.length === 0}
              className="scroll-mt-24"
            >
              <header className="border-b border-border pb-3">
                <h2 id={`cat-title-${category.id}`} className="font-display text-[1.5rem] font-semibold leading-snug">
                  {category.title}
                </h2>
                <p className="mt-1 text-[14.5px] text-muted-foreground">{category.hint}</p>
              </header>

              <div className="mt-2">
                {category.items.map((item) => (
                  <details
                    key={item.id}
                    id={item.id}
                    hidden={!visible.has(item.id)}
                    open={openId === item.id || (searching && visible.has(item.id) && visible.size <= 3)}
                    onToggle={(event) => {
                      if ((event.currentTarget as HTMLDetailsElement).open) setOpenId(item.id);
                      else if (openId === item.id) setOpenId(null);
                    }}
                    className="group scroll-mt-24 border-b border-border"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 [&::-webkit-details-marker]:hidden">
                      <span className="text-[17px] font-medium leading-8">{item.q}</span>
                      <span
                        aria-hidden
                        className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-border text-[18px] leading-none text-muted-foreground transition-transform group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <div className="pb-6 pe-10">
                      <div className="max-w-[42rem] space-y-3 text-[16.5px] leading-9 text-foreground/85">
                        {item.a.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                      {item.link && <FaqLink link={item.link} hrefs={hrefs} />}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function FaqLink({ link, hrefs }: { link: NonNullable<FaqItem['link']>; hrefs: Props['hrefs'] }) {
  const className = cn('mt-4 inline-flex items-center gap-2 text-[15px] font-semibold underline underline-offset-4');
  if (link.kind === 'internal' && link.href) {
    return (
      <Link href={link.href} className={className}>
        {link.label}
      </Link>
    );
  }
  const href = link.kind === 'whatsapp-no-account' ? hrefs.noAccount : hrefs.agency;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      <MessageCircle className="h-4 w-4" aria-hidden />
      {link.label}
    </a>
  );
}
