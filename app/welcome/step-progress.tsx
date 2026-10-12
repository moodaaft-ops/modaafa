import { cn } from '@/lib/utils';
import { WELCOME_QUESTIONS_COPY as copy } from '@/lib/welcome/copy';

/**
 * Two segments, one per step. The finished and current segments are navy; the
 * one still ahead stays a plain outline. The label is real text, so a screen
 * reader hears "الخطوة 2 من 2" and does not depend on the colours.
 */
export function StepProgress({ current, total = 2 }: { current: 1 | 2; total?: number }) {
  return (
    <div className="mt-6" role="group" aria-label={copy.progressLabel(current, total)}>
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="font-semibold text-foreground">{copy.progressLabel(current, total)}</span>
        <span className="text-muted-foreground">{copy.stepNames[current - 1]}</span>
      </div>
      <div className="mt-2 flex gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cn('h-1.5 flex-1', index < current ? 'bg-foreground' : 'bg-border')}
          />
        ))}
      </div>
    </div>
  );
}
