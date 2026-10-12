'use client';

import { useState } from 'react';
import { PlayCircle } from 'lucide-react';
import type { WelcomeVideo } from '@/lib/welcome/config';

/**
 * Click-to-load: nothing is fetched from YouTube and nothing plays until the
 * person presses the frame. The page stays light on a phone connection.
 */
export function WelcomeVideoFrame({ video, caption }: { video: WelcomeVideo; caption: string }) {
  const [playing, setPlaying] = useState(false);

  return (
    <figure>
      <div className="aspect-video w-full overflow-hidden border border-border bg-primary">
        {playing ? (
          <iframe
            src={`${video.embedUrl}${video.embedUrl.includes('?') ? '&' : '?'}autoplay=1&rel=0`}
            title={video.title}
            className="h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group flex h-full w-full flex-col items-center justify-center gap-3 text-primary-foreground"
            aria-label={`تشغيل: ${video.title}`}
          >
            <PlayCircle className="h-14 w-14 transition-transform duration-150 group-hover:scale-105" aria-hidden />
            <span className="text-[13px] font-semibold">{video.title}</span>
          </button>
        )}
      </div>
      <figcaption className="mt-2 text-[12.5px] leading-6 text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
