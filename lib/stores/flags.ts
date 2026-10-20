export function isStoreSyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_SYNC_ENABLED === 'true';
}
