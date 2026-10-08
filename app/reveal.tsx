import { cn } from '@/lib/utils';

/**
 * Entrance animation wrapper. It is pure CSS: the element always ends fully
 * visible, with or without JavaScript, and never waits for a scroll event, so
 * a full-page screenshot or a crawler sees every section. Content that sits
 * below the fold simply finishes its short rise before the visitor reaches it.
 * `motion-reduce:animate-none` (and the global reduced-motion rule) turn the
 * movement off entirely.
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
  return (
    <Tag
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      className={cn('animate-fade-up motion-reduce:animate-none', className)}
    >
      {children}
    </Tag>
  );
}
