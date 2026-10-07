'use client';

import { useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';

/**
 * Hero video slot. The video file that shipped before identity v1.0 is still
 * green, so it is not wired in: set HERO_VIDEO_SRC to the new identity render
 * and the slot switches from the still to the player without any other change.
 *
 * With a source set it does not autoplay: the voiceover is the pitch, and
 * browsers only allow autoplay when muted. The visitor sees the poster with a
 * play button and pressing it plays from the start WITH sound.
 */
const HERO_VIDEO_SRC: string | null = null;
const HERO_POSTER = '/video/modaafa-hero-poster.png';
const HERO_POSTER_ALT =
  'مراحل العمل في مُضاعِف: فحص الحساب، ثم توصية، ثم موافقتك، ثم تنفيذ مع سجل تراجع';

const controlClasses =
  'inline-flex h-10 w-10 items-center justify-center bg-foreground text-background transition-colors hover:bg-foreground/85';

export function HeroVideo() {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);

  if (!HERO_VIDEO_SRC) {
    return (
      <div className="surface-raised mx-auto w-full max-w-5xl overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={HERO_POSTER}
          alt={HERO_POSTER_ALT}
          width={1920}
          height={1080}
          className="block aspect-video w-full object-cover"
        />
      </div>
    );
  }

  function start() {
    const video = ref.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
    if (!started || video.ended) video.currentTime = 0;
    setStarted(true);
    video.play().catch(() => undefined);
  }

  function togglePlay() {
    const video = ref.current;
    if (!video) return;
    if (video.paused) start();
    else video.pause();
  }

  function toggleMute() {
    const video = ref.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  return (
    <div className="surface-raised relative mx-auto w-full max-w-5xl overflow-hidden">
      <video
        ref={ref}
        className="block aspect-video w-full cursor-pointer bg-foreground object-cover"
        src={HERO_VIDEO_SRC}
        poster={HERO_POSTER}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        aria-label="فيديو تعريفي بمنصة مُضاعِف"
      />

      {!playing && (
        <button
          type="button"
          onClick={start}
          className="group absolute inset-0 flex flex-col items-center justify-center gap-3 bg-foreground/40 transition-colors hover:bg-foreground/50"
          aria-label="شغّل الفيديو"
        >
          <span className="flex h-20 w-20 items-center justify-center bg-background text-foreground">
            <Play className="h-9 w-9 translate-x-[-2px]" aria-hidden />
          </span>
          <span className="bg-background px-3.5 py-1.5 text-[13px] font-semibold text-foreground">
            {started ? 'كمّل الفيديو' : 'شوف كيف يشتغل مُضاعِف'}
          </span>
        </button>
      )}

      {playing && (
        <div className="absolute bottom-3 start-3 flex items-center gap-2">
          <button type="button" onClick={togglePlay} className={controlClasses} aria-label="إيقاف مؤقت">
            <Pause className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={toggleMute}
            className={controlClasses}
            aria-label={muted ? 'شغّل الصوت' : 'اكتم الصوت'}
          >
            {muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      )}
    </div>
  );
}
