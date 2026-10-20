/** Owner defaults, bounded to the production safety envelope. No I/O. */
export function settingNumber(key: string, fallback: number, min: number, max: number, env: Record<string, string | undefined> = process.env): number {
  const value = Number(env[key]);
  return env[key]?.trim() && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
