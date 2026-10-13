import { isChatFirstEnabled } from '@/lib/chat-first/flag';

/**
 * The simple experience: chat-style setup with «مُضاعِف», one home screen, and a
 * four-item menu instead of the nine-item sidebar.
 *
 * It rides on the existing CHAT_FIRST_ENTRY switch on purpose, because it is
 * the chat-first entry: the chat API, the permission question and the memory
 * panel already answer only to that flag, so one switch turns the whole thing
 * on or off together.
 * - "true": everyone signed in.
 * - "operators": Modaafa operators and CHAT_FIRST_ALLOWLIST emails only.
 * - anything else: the old screens, unchanged.
 *
 * The email must be the authenticated server-side user's, never the browser's.
 */
export function isSimpleExperience(
  env: Record<string, string | undefined> = process.env,
  email?: string | null
) {
  return isChatFirstEnabled(env, email);
}
