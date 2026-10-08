/**
 * Chat-first entry is shipped dark. It turns on only when the server env
 * CHAT_FIRST_ENTRY is exactly "true", so merging the code changes nothing for
 * existing users until Ayman flips the flag after review.
 */
export function isChatFirstEnabled(env: Record<string, string | undefined> = process.env) {
  return env.CHAT_FIRST_ENTRY === 'true';
}
