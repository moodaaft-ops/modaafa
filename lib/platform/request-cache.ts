import * as React from 'react';

type AsyncFunction = (...args: any[]) => Promise<any>;

/**
 * Next's Server Component runtime exposes React.cache, while the plain React
 * 18 CommonJS build used by `tsx --test` does not. Keep request memoisation in
 * production and use a transparent pass-through in non-RSC test processes.
 */
export function requestCache<T extends AsyncFunction>(fn: T): T {
  const cache = (React as typeof React & { cache?: <F extends T>(callback: F) => F }).cache;
  return cache ? cache(fn) : fn;
}
