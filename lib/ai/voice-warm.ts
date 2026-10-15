/**
 * Wake-up calls sent when a call starts. A serverless function that has not
 * run for a while starts cold, and the first question of a call would pay for
 * three of those in a row (speech-to-text, chat, text-to-speech). The person
 * spends the next several seconds on the microphone prompt and the first
 * sentence, so these are fire-and-forget requests that finish well before they
 * are needed. Each route answers its GET with an empty 204 and does nothing
 * else: no sign-in, no provider, no model call, no charge.
 */
export const WARM_URLS = ['/api/voice/transcribe', '/api/voice/speak', '/api/chat/start?warm=1'] as const;

export function warmVoiceRoutes(fetcher: typeof fetch = fetch) {
  for (const url of WARM_URLS) {
    try {
      void fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }).catch(() => undefined);
    } catch {
      // Warming is a courtesy; never the reason a call fails to start.
    }
  }
}
