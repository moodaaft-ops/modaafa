import { cn } from '@/lib/utils';
import { ASSISTANT } from '@/lib/assistant/persona';

/**
 * the assistant's face is the brand symbol itself: the small square touching its
 * double, with the yellow lamp in the corner. The lamp blinks while he is
 * thinking or typing, and that is the only motion he has.
 *
 * Squares are drawn in currentColor so the mark flips with the theme; the
 * lamp keeps the signal yellow in both.
 */
export function AssistantAvatar({
  size = 36,
  thinking = false,
  className,
  framed = true,
}: {
  size?: number;
  thinking?: boolean;
  className?: string;
  /** A hairline square around the mark, for chat rows. Off for inline use. */
  framed?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center justify-center text-foreground',
        framed && 'border border-border bg-card',
        className
      )}
      style={{ width: size, height: size }}
      role="img"
      aria-label={thinking ? `${ASSISTANT.name} يفكر` : ASSISTANT.name}
    >
      <svg viewBox="0 0 12 12" width={Math.round(size * (framed ? 0.56 : 1))} height={Math.round(size * (framed ? 0.56 : 1))} aria-hidden>
        <rect x="4" y="0" width="8" height="8" fill="currentColor" />
        <rect x="0" y="8" width="4" height="4" fill="currentColor" />
        <rect
          x="10"
          y="0"
          width="2"
          height="2"
          fill="#FBBC04"
          className={cn(thinking && 'motion-safe:animate-lamp-blink')}
        />
      </svg>
    </span>
  );
}

/** «مُضاعِف يكتب…»: three small squares stepping, read aloud as text. */
export function TypingSquares({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)} role="status" aria-label={`${ASSISTANT.name} يكتب`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 bg-foreground/70 motion-safe:animate-square-step"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}
