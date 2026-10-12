import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/*
 * Background texture for the landing page, built from the logo itself: the
 * mark is one big square with a small square touching its lower corner, so
 * the field is a faint 24px dot grid with scattered squares in three sizes and
 * the occasional big+small pair. Two tiles of different widths (20 and 28
 * cells) overlap so the repeat is hard to spot, and everything is drawn in
 * px so a cell stays 24px on every screen. Server-rendered and deterministic.
 */

const CELL = 24;

type Square = { x: number; y: number; s: number; o: number };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tile(cells: number, seed: number, density: number): Square[] {
  const rand = mulberry32(seed);
  const out: Square[] = [];
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const r = rand();
      if (r > density) continue;
      const x = col * CELL;
      const y = row * CELL;
      const kind = rand();
      if (kind < 0.5) {
        out.push({ x: x + 9, y: y + 9, s: 6, o: 1 });
      } else if (kind < 0.85) {
        out.push({ x: x + 12, y, s: 12, o: 0.8 });
      } else if (col > 0 && row < cells - 1) {
        // The logo pair: a full cell, and a half cell off its lower corner.
        out.push({ x, y, s: CELL, o: 0.7 });
        out.push({ x: x - 12, y: y + CELL, s: 12, o: 0.7 });
      }
    }
  }
  return out;
}

const TILE_A = { cells: 20, squares: tile(20, 7, 0.07) };
const TILE_B = { cells: 28, squares: tile(28, 41, 0.035) };

const TONES = {
  paper: { ink: '#0E1426', dot: 0.3, square: 0.13 },
  navy: { ink: '#F4F2EC', dot: 0.22, square: 0.09 },
} as const;

export function SquareField({
  tone,
  id,
  fade,
  lamp,
  className,
}: {
  tone: keyof typeof TONES;
  /** Unique per instance: pattern ids are document-global. */
  id: string;
  /** Where the field shows: 'edges' keeps the middle clean, 'left' fades toward the right. */
  fade: 'edges' | 'left';
  /** Draw the single yellow square (use once per page). */
  lamp?: boolean;
  className?: string;
}) {
  const t = TONES[tone];
  const mask =
    fade === 'edges'
      ? 'radial-gradient(ellipse 80% 75% at 50% 50%, rgba(0,0,0,0.25) 30%, #000 100%)'
      : 'linear-gradient(to right, #000 0%, #000 40%, rgba(0,0,0,0.45) 70%, rgba(0,0,0,0.25) 100%)';
  const style: CSSProperties = { maskImage: mask, WebkitMaskImage: mask };

  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 -z-10 overflow-hidden', className)}>
      <svg className="absolute inset-0 h-full w-full" style={style}>
        <defs>
          <pattern id={`${id}-dots`} width={CELL} height={CELL} patternUnits="userSpaceOnUse">
            <rect x={11} y={11} width={2} height={2} fill={t.ink} fillOpacity={t.dot} />
          </pattern>
          {[TILE_A, TILE_B].map((tl, i) => (
            <pattern
              key={i}
              id={`${id}-t${i}`}
              width={tl.cells * CELL}
              height={tl.cells * CELL}
              patternUnits="userSpaceOnUse"
            >
              {tl.squares.map((q, k) => (
                <rect key={k} x={q.x} y={q.y} width={q.s} height={q.s} fill={t.ink} fillOpacity={t.square * q.o} />
              ))}
            </pattern>
          ))}
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id}-dots)`} />
        <rect width="100%" height="100%" fill={`url(#${id}-t0)`} />
        <rect width="100%" height="100%" fill={`url(#${id}-t1)`} />
      </svg>
      {lamp && (
        <span
          className="absolute h-3 w-3 bg-brand-signal motion-safe:animate-lamp"
          style={{ left: CELL * 2 + 12, top: CELL * 2 }}
        />
      )}
    </div>
  );
}
