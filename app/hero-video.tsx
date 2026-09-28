'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Hero sales video. Starts muted and looping (the only way browsers allow
 * autoplay), with a clear control to restart it with sound — the voiceover is
 * the pitch, so "play with sound" is the primary action on the player.
 * Visitors who prefer reduced motion get the poster and a play button instead
 * of autoplay.
 */
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    video.play().catch(() => {
      // Autoplay blocked (e.g. low-power mode): the play button stays visible.
    });
  }, []);

  function playWithSound() {
    const video = ref.current;
    if (!video) return;
    video.muted = false;
    video.loop = false;
    video.currentTime = 0;
    setMuted(false);
    video.play().catch(() => undefined);
  }

  function toggleMute() {
    const video = ref.current;
    if (!video) return;
    if (muted && video.currentTime > 0 && !video.loop) {
      video.muted = false;
      setMuted(false);
      return;
    }
    if (muted) {
      playWithSound();
      return;
    }
    video.muted = true;
    setMuted(true);
  }

  return (
    <div className="surface-raised relative mx-auto w-full max-w-5xl overflow-hidden">
      <video
        ref={ref}
        className="block aspect-video w-full bg-background-elevated object-cover"
        src="/video/modaafa-hero.mp4"
        poster="/video/modaafa-hero-poster.jpg"
        muted
        loop
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          const video = ref.current;
          if (!video) return;
          video.muted = true;
          video.loop = true;
          setMuted(true);
          video.play().catch(() => undefined);
        }}
        aria-label="فيديو تعريفي بمنصة مُضاعِف"
      />

      {!playing && (
        <button
          type="button"
          onClick={playWithSound}
          className="absolute inset-0 flex items-center justify-center bg-black/10 transition hover:bg-black/20"
          aria-label="شغّل الفيديو بالصوت"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
            <Play className="h-7 w-7 translate-x-[-2px]" aria-hidden />
          </span>
        </button>
      )}

      {playing && (
        <button
          type="button"
          onClick={toggleMute}
          className={cn(
            'absolute bottom-3 start-3 inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-semibold shadow-lg backdrop-blur transition',
            muted
              ? 'bg-primary text-primary-foreground hover:opacity-90'
              : 'bg-black/55 text-white hover:bg-black/70',
          )}
          aria-label={muted ? 'شغّل الصوت' : 'اكتم الصوت'}
        >
          {muted ? <Volume2 className="h-4 w-4" aria-hidden /> : <VolumeX className="h-4 w-4" aria-hidden />}
          {muted ? 'شغّل بالصوت' : 'كتم'}
        </button>
      )}
    </div>
  );
}
