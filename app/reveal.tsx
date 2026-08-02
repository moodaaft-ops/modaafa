'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Scroll-reveal wrapper. Adds a soft rise-and-fade the first time the element
 * enters the viewport, so the marketing page feels alive on scroll instead of
 * static. Respects prefers-reduced-motion via the global CSS override (the
 * animation duration is collapsed there), and never hides content from crawlers
 * or no-JS clients — it starts hidden only after mount.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'section' | 'li' | 'article';
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    // Only arm the hidden→shown transition on the client, so SSR/no-JS renders
    // fully visible content.
    setArmed(true);
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const Component = Tag as any;

  return (
    <Component
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        armed && 'transition-[opacity,transform] duration-700 ease-snap motion-reduce:transition-none',
        armed && !shown && 'translate-y-4 opacity-0',
        armed && shown && 'translate-y-0 opacity-100',
        className
      )}
    >
      {children}
    </Component>
  );
}
