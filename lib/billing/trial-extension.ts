const DAY_MS = 24 * 60 * 60 * 1000;

/** New trial end: the extension counts from the later of now and the current end. */
export function computeExtendedTrialEnd(currentTrialEnd: string | null, days: number, now = Date.now()) {
  const current = currentTrialEnd ? new Date(currentTrialEnd).getTime() : NaN;
  const base = Number.isFinite(current) && current > now ? current : now;
  return new Date(base + days * DAY_MS);
}
