'use client';

import { useRef, useState } from 'react';
import { Play, PlayCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PLATFORM_GUIDE_CHAPTERS,
  PLATFORM_GUIDE_COVER,
  PLATFORM_GUIDE_NOTE,
  PLATFORM_GUIDE_TITLE,
  formatGuideTime,
  platformGuideEmbedUrl,
} from '@/lib/onboarding/platform-guide';

/** Chapter buttons under the player. Picking one restarts the player at that second. */
function ChapterChips({ current, onPick }: { current: number; onPick: (start: number) => void }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="فصول الفيديو">
      {PLATFORM_GUIDE_CHAPTERS.map((chapter) => {
        const active = chapter.start === current;
        return (
          <li key={chapter.id}>
            <button
              type="button"
              onClick={() => onPick(chapter.start)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
                active
                  ? 'border-foreground bg-foreground font-semibold text-background'
                  : 'border-border bg-card text-foreground hover:bg-muted'
              )}
            >
              <span className="tabular-nums text-[12px] opacity-70" dir="ltr">
                {formatGuideTime(chapter.start)}
              </span>
              {chapter.title}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A button that opens the guide in a native <dialog> (the browser traps focus
 * and handles Esc). The iframe exists only while the dialog is open, so nothing
 * loads from YouTube until the customer asks. `start` is the second the player
 * opens at; the chapter chips move it.
 */
export function PlatformGuideDialog({
  start = 0,
  variant = 'link',
  label,
  hint,
  className,
}: {
  start?: number;
  variant?: 'card' | 'link' | 'row';
  label: string;
  /** `card` only: the quiet second line. */
  hint?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(start);

  function show() {
    setAt(start);
    setOpen(true);
    ref.current?.showModal();
  }
  function hide() {
    ref.current?.close();
    setOpen(false);
  }

  return (
    <>
      {variant === 'card' ? (
        <button
          type="button"
          onClick={show}
          className={cn(
            'flex w-full items-center gap-3 rounded-[16px] border border-border bg-muted/50 px-4 py-3 text-start transition-colors hover:bg-muted',
            className
          )}
        >
          <PlayCircle className="h-6 w-6 flex-shrink-0 text-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-6">{label}</span>
            {hint && <span className="block text-[12.5px] leading-5 text-muted-foreground">{hint}</span>}
          </span>
        </button>
      ) : variant === 'row' ? (
        <button
          type="button"
          onClick={show}
          className={cn(
            'flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-start text-[14px] text-foreground transition-colors hover:bg-foreground/[0.06]',
            className
          )}
        >
          <PlayCircle className="h-[18px] w-[18px]" aria-hidden />
          {label}
        </button>
      ) : (
        <button
          type="button"
          onClick={show}
          className={cn(
            'mx-auto flex items-center justify-center gap-1.5 text-[13.5px] font-semibold text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline',
            className
          )}
        >
          <PlayCircle className="h-4 w-4" aria-hidden />
          {label}
        </button>
      )}

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === ref.current) hide();
        }}
        aria-label={PLATFORM_GUIDE_TITLE}
        className="w-[calc(100vw-24px)] max-w-3xl rounded-[18px] border border-border bg-background p-0 text-foreground backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="min-w-0 truncate text-[14px] font-semibold">{PLATFORM_GUIDE_TITLE}</p>
          <button
            type="button"
            onClick={hide}
            aria-label="إغلاق"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="aspect-video w-full bg-black">
          {open && (
            <iframe
              key={at}
              src={platformGuideEmbedUrl({ start: at })}
              title={PLATFORM_GUIDE_TITLE}
              className="h-full w-full"
              allow="encrypted-media; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          )}
        </div>
        <div className="space-y-3 px-4 py-3">
          <ChapterChips current={at} onPick={setAt} />
          <p className="text-[12.5px] leading-6 text-muted-foreground">{PLATFORM_GUIDE_NOTE}</p>
        </div>
      </dialog>
    </>
  );
}

/**
 * The page version (/guide). Until someone presses play it is only the cover, so
 * the page itself costs nothing; the press mounts the iframe with autoplay on,
 * since the press is the request to play.
 */
export function PlatformGuidePlayer() {
  const [start, setStart] = useState(0);
  const [playing, setPlaying] = useState(false);

  function play(at: number) {
    setStart(at);
    setPlaying(true);
  }

  return (
    <div className="space-y-4">
      <div className="relative aspect-video w-full overflow-hidden rounded-[18px] border border-border bg-black">
        {playing ? (
          <iframe
            key={start}
            src={platformGuideEmbedUrl({ start, autoplay: true })}
            title={PLATFORM_GUIDE_TITLE}
            className="absolute inset-0 h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" onClick={() => play(0)} aria-label="شغّل الفيديو" className="group absolute inset-0 block w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={PLATFORM_GUIDE_COVER} alt="" className="h-full w-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover:bg-black/20">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#FBBC04] text-[#0E1426] shadow-lg">
                <Play className="h-7 w-7 fill-current" aria-hidden />
              </span>
            </span>
          </button>
        )}
      </div>
      <ChapterChips current={playing ? start : -1} onPick={play} />
      <p className="text-[12.5px] leading-6 text-muted-foreground">{PLATFORM_GUIDE_NOTE}</p>
    </div>
  );
}
