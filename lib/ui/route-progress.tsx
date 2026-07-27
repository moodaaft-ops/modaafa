'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

export function RouteProgress() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(false);
  }, [pathname]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target as Element | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;

      const current = `${window.location.pathname}${window.location.search}`;
      const next = `${nextUrl.pathname}${nextUrl.search}`;
      if (current === next) return;

      setLoading(true);
    }

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

  useEffect(() => {
    if (!loading) return;
    const timeout = window.setTimeout(() => setLoading(false), 15000);
    return () => window.clearTimeout(timeout);
  }, [loading]);

  if (!loading) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80]" dir="rtl">
      <div className="h-1 w-full overflow-hidden bg-primary/20">
        <div className="h-full w-1/2 animate-loading-bar rounded-full bg-primary" />
      </div>
      <div className="mx-auto mt-3 flex w-fit items-center gap-2 surface-card px-4 py-2 text-xs font-semibold text-foreground shadow-soft">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        جاري تحميل الصفحة...
      </div>
    </div>
  );
}
