'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Phone-only bottom bar. It stays hidden while the hero's own buttons are on
 * screen and appears once they scroll away, so the visitor always has the
 * free audit one tap away without two identical buttons stacked together.
 */
export function StickyCta({ watchId, whatsappHref }: { watchId: string; whatsappHref: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = document.getElementById(watchId);
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { threshold: 0 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [watchId]);

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        'fixed inset-x-0 bottom-0 z-50 border-t border-brand-navy/20 bg-brand-paper px-4 pt-3 transition-transform duration-300 ease-snap motion-reduce:transition-none lg:hidden',
        'pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
        visible ? 'translate-y-0' : 'pointer-events-none translate-y-full'
      )}
    >
      <div className="mx-auto flex max-w-md items-center gap-2">
        <Link
          href="/login"
          tabIndex={visible ? 0 : -1}
          className="flex h-12 flex-1 items-center justify-center bg-brand-navy text-[15px] font-bold text-brand-paper"
        >
          افحص حسابك مجاناً
        </Link>
        <a
          href={whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={visible ? 0 : -1}
          aria-label="كلّمنا على الواتساب"
          className="flex h-12 w-12 items-center justify-center border border-brand-navy/30 text-brand-navy"
        >
          <MessageCircle className="h-5 w-5" aria-hidden />
        </a>
      </div>
    </div>
  );
}
