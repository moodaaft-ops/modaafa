'use client';

import { useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';

/**
 * Hero sales video. It does not autoplay: the voiceover is the pitch, and
 * browsers only allow autoplay when muted. The visitor sees the poster with a
 * large play button, and pressing it plays the video from the start WITH
 * sound. Clicking the video itself pauses/resumes; a small control mutes.
 */
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);

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
        className="block aspect-video w-full cursor-pointer bg-background-elevated object-cover"
        src="/video/modaafa-hero.mp4"
        poster="/video/modaafa-hero-poster.jpg"
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
          className="group absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/25 transition hover:bg-black/35"
          aria-label="شغّل الفيديو"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-primary text-primary-foreground transition group-hover:scale-105">
            <Play className="h-9 w-9 translate-x-[-2px]" aria-hidden />
          </span>
          <span className="rounded-full bg-black/55 px-3.5 py-1.5 text-[13px] font-semibold text-white">
            {started ? 'كمّل الفيديو' : 'شوف كيف يشتغل مُضاعِف · 32 ثانية'}
          </span>
        </button>
      )}

      {playing && (
        <div className="absolute bottom-3 start-3 flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlay}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70"
            aria-label="إيقاف مؤقت"
          >
            <Pause className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={toggleMute}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70"
            aria-label={muted ? 'شغّل الصوت' : 'اكتم الصوت'}
          >
            {muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      )}
    </div>
  );
}
