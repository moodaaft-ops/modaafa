'use client';

import { useRef, useState } from 'react';
import { PlayCircle, X } from 'lucide-react';
import { buttonClasses } from '@/lib/ui/button';
import type { GuideVideo } from '@/lib/onboarding/ads-guide';

/**
 * Opens the explainer in a native <dialog>: the browser handles focus trapping
 * and Esc. The iframe is only mounted while the dialog is open, so nothing
 * loads (and nothing plays) until the customer asks for it.
 */
export function GuideVideoButton({ video }: { video: GuideVideo }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  function show() {
    setOpen(true);
    ref.current?.showModal();
  }
  function hide() {
    ref.current?.close();
    setOpen(false);
  }

  return (
    <>
      <button type="button" onClick={show} className={buttonClasses({ variant: 'outline' })}>
        <PlayCircle className="h-4 w-4" />
        شاهد الشرح بالفيديو
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === ref.current) hide();
        }}
        aria-label={video.title}
        className="w-[calc(100vw-32px)] max-w-2xl border border-border bg-background p-0 text-foreground backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="min-w-0 truncate text-[13px] font-semibold">{video.title}</p>
          <button type="button" onClick={hide} aria-label="إغلاق" className={buttonClasses({ variant: 'ghost' })}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="aspect-video w-full bg-black">
          {open && (
            <iframe
              src={video.embedUrl}
              title={video.title}
              className="h-full w-full"
              allow="encrypted-media; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
            />
          )}
        </div>
        <p className="px-4 py-3 text-[12.5px] leading-6 text-muted-foreground">
          ما اشتغل الفيديو أو طلع مختلف عن شاشتك؟ الخطوات المكتوبة تحت الفيديو تكفي وحدها. أغلق النافذة وكمّل منها.
        </p>
      </dialog>
    </>
  );
}
